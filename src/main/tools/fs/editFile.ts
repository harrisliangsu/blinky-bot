/**
 * `edit_file` — exact string replacement with a uniqueness check.
 *
 * The old string must appear exactly once unless `replace_all` is set, which
 * makes edits deterministic and stops the model from silently changing the
 * wrong occurrence. The approval preview is a real unified diff.
 */

import type { ToolSchema } from '../../../shared/types'
import { optBool, optStr, reqStr } from '../args'
import { requireApproval } from '../approval'
import { diffStats, unifiedDiff } from '../diff'
import { ToolError } from '../errors'
import {
  displayPath,
  noteApprovedTarget,
  outsideAccessRequiresConfirmation,
  outsideNotice,
  outsideResolvedTarget,
  resolveTarget
} from '../paths'
import { defineTool } from '../results'
import { looksBinary, truncateEnd } from '../text'
import { commitMutation, snapshotMutationTarget, withMutationLock } from './mutation'

const NAME = 'edit_file'
const MAX_PREVIEW_CHARS = 8000

export const schema: ToolSchema = {
  name: NAME,
  description:
    'Replace an exact string in a file. old_string must match character for character (including ' +
    'indentation) and must be unique in the file — include surrounding lines to disambiguate — unless ' +
    'replace_all is true. Returns a unified diff of what changed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit.' },
      old_string: { type: 'string', description: 'Exact text to find, including whitespace.' },
      new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  mutating: true
}

export const editFileTool = defineTool(schema, async (args, ctx) => {
  const input = reqStr(args, 'path', NAME)
  const oldString = reqStr(args, 'old_string', NAME)
  const newString = optStr(args, 'new_string') ?? ''
  const replaceAll = optBool(args, 'replace_all', false)

  if (oldString === newString) {
    throw new ToolError('old_string and new_string are identical, so there is nothing to change.')
  }

  const initial = await resolveTarget(ctx, input, { tool: NAME, mode: 'write' })
  const absolute = initial.absolute
  return withMutationLock(absolute, async (resolvedPath) => {
    const outside = await outsideResolvedTarget(ctx, resolvedPath, 'write')
    const shown = displayPath(ctx, absolute)

    // Outside the workspace nothing is read until the user has agreed to the
    // physical, locked target. A symlink retarget cannot change what is read.
    if (outside) {
      await requireApproval(
        ctx,
        {
          toolName: NAME,
          kind: 'edit',
          summary: `Edit ${absolute} — outside the workspace`,
          detail: [
            outsideNotice(ctx, outside),
            '',
            replaceAll ? 'Replace every occurrence of:' : 'Replace:',
            truncateEnd(oldString, MAX_PREVIEW_CHARS / 2, 'truncated'),
            '',
            'With:',
            truncateEnd(newString, MAX_PREVIEW_CHARS / 2, 'truncated')
          ].join('\n')
        },
        { force: outsideAccessRequiresConfirmation(ctx) }
      )
      noteApprovedTarget(ctx, outside, 'write')
    }

    const snapshot = await snapshotMutationTarget(absolute, resolvedPath)
    if (!snapshot.exists) throw new ToolError(`${shown} does not exist.`)
    if (snapshot.isDirectory) throw new ToolError(`${shown} is a directory, not a file.`)
    const original = snapshot.bytes!
    if (looksBinary(original.subarray(0, 8192))) {
      throw new ToolError(`${shown} looks binary; edit_file only handles text files.`)
    }
    const before = original.toString('utf8')

    const occurrences = countOccurrences(before, oldString)
    if (occurrences === 0) {
      throw new ToolError(
        `old_string was not found in ${shown}.`,
        'Read the file again and copy the text exactly — whitespace, indentation and line breaks all count.'
      )
    }
    if (occurrences > 1 && !replaceAll) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${shown}, so the edit is ambiguous.`,
        'Add surrounding lines to old_string until it is unique, or pass replace_all: true to change every occurrence.'
      )
    }

    const after = replaceAll ? before.split(oldString).join(newString) : replaceFirst(before, oldString, newString)
    const diff = unifiedDiff(before, after, { oldPath: `a/${shown}`, newPath: `b/${shown}` })
    const stats = diffStats(diff)

    await requireApproval(ctx, {
      toolName: NAME,
      kind: 'edit',
      summary: `Edit ${shown} (+${stats.added}/-${stats.removed}${occurrences > 1 ? `, ${occurrences} occurrences` : ''})`,
      detail: truncateEnd(diff, MAX_PREVIEW_CHARS, 'diff truncated')
    })

    await commitMutation(snapshot, after)

    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: true,
      output: `Edited ${shown} — ${occurrences > 1 ? `${occurrences} replacements, ` : ''}+${stats.added}/-${stats.removed} lines.\n\n${truncateEnd(diff, MAX_PREVIEW_CHARS, 'diff truncated')}`,
      detail: {
        path: shown,
        absolute,
        diff,
        replacements: replaceAll ? occurrences : 1,
        added: stats.added,
        removed: stats.removed
      }
    }
  })
})

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle)
  if (idx === -1) return haystack
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}
