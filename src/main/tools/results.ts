/**
 * `ToolResult` construction and the `defineTool` wrapper that makes the
 * "handlers never throw" rule structural rather than a convention.
 */

import type { ToolResult, ToolSchema } from '../../shared/types'
import { describeError } from './errors'
import { isLocalResourceTool, LOCAL_READ_TOOLS, LOCAL_EXECUTION_REFUSAL, localExecutionPolicy } from '../../shared/localExecution'
import { settingsOf } from './settings'
import { localOperationSignal } from '../localExecution'
import { executionApprovalSettings, executorAccessSignal, fullAccessExecutor } from '../agent/executionAgent'
import { deniedRuleForCall, denyRefusal, evaluate, targetForCall } from '../agent/approvalPolicy'
import type { Tool, ToolContext } from './types'

export function ok(
  ctx: ToolContext,
  name: string,
  output: string,
  extra: Partial<ToolResult> = {}
): ToolResult {
  return { callId: ctx.callId ?? '', name, ok: true, output, ...extra }
}

export function fail(
  ctx: ToolContext,
  name: string,
  output: string,
  extra: Partial<ToolResult> = {}
): ToolResult {
  return { callId: ctx.callId ?? '', name, ok: false, output, ...extra }
}

/**
 * Bind a schema to an implementation.
 *
 * The returned handler stamps `callId`/`name`/`durationMs` and catches
 * everything — including programmer errors — so a bad tool can never break the
 * agent loop.
 */
export function defineTool(
  schema: ToolSchema,
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
): Tool {
  return {
    schema,
    async handler(args, ctx) {
      const started = Date.now()
      let dispose: (() => void) | undefined
      try {
        if (ctx.getSettings) ctx = { ...ctx, settings: ctx.getSettings() }
        if (ctx.signal.aborted) return fail(ctx, schema.name, 'Stopped before this tool ran.')
        if (isLocalResourceTool(schema.name) && ctx.computerTarget?.kind !== 'vm') {
          const settings = settingsOf(ctx)
          const local = localExecutionPolicy(settings)
          if (local === 'never-allow') return fail(ctx, schema.name, LOCAL_EXECUTION_REFUSAL)
          if (ctx.settings) {
            const denied = deniedRuleForCall(ctx.settings, { id: ctx.callId ?? '', name: schema.name, args })
            if (denied) return fail(ctx, schema.name, denyRefusal(schema.name, denied))
          }
          const independent = fullAccessExecutor(ctx.sessionId)
          const accessSignal = independent ? executorAccessSignal(ctx.sessionId) : undefined
          const operation = localOperationSignal(accessSignal ? AbortSignal.any([ctx.signal, accessSignal]) : ctx.signal, ctx.settings, independent)
          dispose = operation.dispose
          const refreshSettings = ctx.getSettings
          if (ctx.settings) ctx = { ...ctx, settings: executionApprovalSettings(ctx.settings, ctx.sessionId, true), ...(refreshSettings ? { getSettings: () => executionApprovalSettings(refreshSettings(), ctx.sessionId, true) } : {}) }
          const applicationApproval = ctx.requestApproval
          ctx = { ...ctx, signal: operation.signal, requestApproval: async (request) => {
            if (operation.signal.aborted) return false
            const approved = await applicationApproval(request)
            return approved && !operation.signal.aborted
          } }
          // Reads inside the workspace used to bypass approval entirely. One
          // grant covers this call, including its symlink/containment check.
          const call = { id: ctx.callId ?? '', name: schema.name, args }
          const readVerdict = ctx.settings ? evaluate(ctx.settings, schema.name, targetForCall(call), new Set(), false, false, true, call) : { outcome: 'ask' }
          const previewsFile = schema.name === 'write_file' || schema.name === 'edit_file'
          if ((LOCAL_READ_TOOLS.has(schema.name) || previewsFile) && readVerdict.outcome === 'ask') {
            const granted = await ctx.requestApproval({
              id: crypto.randomUUID(), sessionId: ctx.sessionId, toolName: schema.name, kind: 'fetch',
              summary: previewsFile
                ? `Read file for change preview / 读取文件以预览改动: ${String(args.path ?? '')}`
                : `${schema.name}: ${String(args.path ?? args.pattern ?? '.')}`,
              detail: JSON.stringify(args, null, 2).slice(0, 8000)
            })
            if (!granted || ctx.signal.aborted) return fail(ctx, schema.name, '本次操作未获批准。 / This action was not approved.')
            const requestApproval = ctx.requestApproval
            ctx = previewsFile
              // Accessing the old contents does not also approve their mutation.
              // Keep the handler's diff/target approval visible as a separate action.
              ? { ...ctx, requestApproval: req => requestApproval({ ...req, force: true }) }
              : { ...ctx, requestApproval: req => req.force ? requestApproval(req) : Promise.resolve(!ctx.signal.aborted) }
          }
        }
        const result = await run(args ?? {}, ctx)
        if (ctx.signal.aborted) return fail(ctx, schema.name, 'Stopped while this tool was running.')
        return {
          ...result,
          callId: result.callId || ctx.callId || '',
          name: result.name || schema.name,
          durationMs: result.durationMs ?? Date.now() - started
        }
      } catch (err) {
        return {
          callId: ctx.callId ?? '',
          name: schema.name,
          ok: false,
          output: describeError(err, schema.name),
          durationMs: Date.now() - started
        }
      } finally {
        dispose?.()
      }
    }
  }
}
