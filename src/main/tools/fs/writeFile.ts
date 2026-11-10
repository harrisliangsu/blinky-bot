/**
 * `write_file` — create or overwrite a file, behind the approval gate and with
 * a unified diff in the preview when the file already exists.
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
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
import { bytesOf, formatBytes, splitLines, truncateEnd } from '../text'
import { commitMutation, snapshotMutationTarget, withMutationLock } from './mutation'

const NAME = 'write_file'
const MAX_PREVIEW_CHARS = 8000

export const schema: ToolSchema = {
  name: NAME,
  description:
    'Write a file, replacing it entirely if it exists. The user approves the change first and sees a ' +
    'diff for existing files. Prefer edit_file for small changes to a large file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write, relative to the working directory or absolute.' },
      content: { type: 'string', description: 'Full new contents of the file.' },
      create_dirs: { type: 'boolean', description: 'Create missing parent directories. Default true.' }
    },
    required: ['path', 'content']
  },
  mutating: true
}

export const writeFileTool = defineTool(schema, async (args, ctx) => {
  const input = reqStr(args, 'path', NAME)
  const content = optStr(args, 'content') ?? ''
  const createDirs = optBool(args, 'create_dirs', true)
  const initial = await resolveTarget(ctx, input, { tool: NAME, mode: 'write' })
  const absolute = initial.absolute
  return withMutationLock(absolute, async (resolvedPath) => {
    const outside = await outsideResolvedTarget(ctx, resolvedPath, 'write')
    const shown = displayPath(ctx, absolute)

    // Outside the workspace the physical, locked target is neither read nor
    // diffed until the user has agreed to it.
    if (outside) {
      await requireApproval(
        ctx,
        {
          toolName: NAME,
          kind: 'write',
          summary: `Write ${absolute} (${formatBytes(bytesOf(content))}) — outside the workspace`,
          detail: `${outsideNotice(ctx, outside)}\n\n${truncateEnd(content, MAX_PREVIEW_CHARS, 'preview truncated')}`
        },
        { force: outsideAccessRequiresConfirmation(ctx) }
      )
      noteApprovedTarget(ctx, outside, 'write')
    }

    const snapshot = await snapshotMutationTarget(absolute, resolvedPath)
    if (snapshot.isDirectory) {
      throw new ToolError(`${shown} is a directory.`, 'Choose a file path instead.')
    }
    const existing = snapshot.exists ? { text: snapshot.bytes!.toString('utf8') } : undefined

    const diff = existing
      ? unifiedDiff(existing.text, content, { oldPath: `a/${shown}`, newPath: `b/${shown}` })
      : ''
    const stats = existing ? diffStats(diff) : { added: splitLines(content).length, removed: 0 }

    if (existing && diff === '') {
      return {
        callId: ctx.callId ?? '',
        name: NAME,
        ok: true,
        output: `${shown} already has exactly this content; nothing was written.`,
        detail: { path: shown, absolute, unchanged: true }
      }
    }

    await requireApproval(ctx, {
      toolName: NAME,
      kind: existing ? 'edit' : 'write',
      summary: existing
        ? `Overwrite ${shown} (+${stats.added}/-${stats.removed})`
        : `Create ${shown} (${formatBytes(bytesOf(content))})`,
      detail: existing
        ? truncateEnd(diff, MAX_PREVIEW_CHARS, 'diff truncated')
        : truncateEnd(content, MAX_PREVIEW_CHARS, 'preview truncated')
    })

    if (createDirs) await mkdir(dirname(resolvedPath), { recursive: true })
    await commitMutation(snapshot, content)

    const lines = splitLines(content).length
    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: true,
      output: `${existing ? 'Overwrote' : 'Created'} ${shown} — ${lines} line${lines === 1 ? '' : 's'}, ${formatBytes(bytesOf(content))}.`,
      detail: { path: shown, absolute, created: !existing, diff, added: stats.added, removed: stats.removed }
    }
  })
})
