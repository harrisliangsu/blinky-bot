import { useMemo, useState, type ReactNode } from 'react'
import type { ToolCall, ToolResult } from '../../../shared/types'
import { extractDiff } from '../lib/diff'
import { formatDuration, pngSrc, safeJson, summarizeArgs } from '../lib/format'
import { DiffView } from './DiffView'
import type { VisualizationSpec } from '../../../shared/types'
import { ErrorBoundary } from './ErrorBoundary'
import { Visualization } from './Visualization'
import { IconCheck, IconChevronDown, IconChevronRight, IconClose, IconSpinner } from './Icons'
import './ToolCallView.css'

interface ToolCallViewProps {
  call: ToolCall
  result?: ToolResult
  /** Settings → show assistant steps. Only the first paint uses it. */
  defaultOpen?: boolean
}

type Status = 'running' | 'ok' | 'failed'

const OUTPUT_LIMIT = 8000

function StatusIcon({ status }: { status: Status }): ReactNode {
  if (status === 'running') return <IconSpinner size={12} />
  if (status === 'ok') return <IconCheck size={12} />
  return <IconClose size={12} />
}

const STATUS_LABEL: Record<Status, string> = {
  running: 'Running',
  ok: 'Succeeded',
  failed: 'Failed'
}

/** One tool invocation: collapsed to a single row, expanded to args + output. */
export function ToolCallView({ call, result, defaultOpen = false }: ToolCallViewProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const status: Status = result ? (result.ok ? 'ok' : 'failed') : 'running'
  const detail = result?.detail
  const chart =
    detail && typeof detail === 'object' && 'visualization' in detail
      ? (detail as { visualization: VisualizationSpec }).visualization
      : null
  const summary = useMemo(() => summarizeArgs(call.name, call.args ?? {}), [call.name, call.args])
  const diff = useMemo(() => (open ? extractDiff(call, result) : null), [open, call, result])

  const argEntries = Object.entries(call.args ?? {})
  const output = result?.output ?? ''
  const clipped = output.length > OUTPUT_LIMIT

  return (
    <div className={`ob-tool ob-tool-${status}`}>
      <button
        type="button"
        className="ob-tool-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${STATUS_LABEL[status]}: ${call.name}${summary ? ` ${summary}` : ''}`}
      >
        <span className="ob-tool-caret" aria-hidden="true">
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className={`ob-tool-status ob-tool-status-${status}`} title={STATUS_LABEL[status]}>
          <StatusIcon status={status} />
        </span>
        <span className="ob-tool-name">{call.name}</span>
        {summary ? <span className="ob-tool-summary">{summary}</span> : null}
        {result?.durationMs !== undefined ? (
          <span className="ob-tool-duration">{formatDuration(result.durationMs)}</span>
        ) : null}
      </button>

      {open ? (
        <div className="ob-tool-detail">
          {argEntries.length > 0 ? (
            <section>
              <h4 className="ob-tool-label">Arguments</h4>
              <dl className="ob-tool-args">
                {argEntries.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'string' ? value : safeJson(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {diff ? (
            <section>
              <h4 className="ob-tool-label">Changes</h4>
              <DiffView
                lines={diff.lines}
                path={diff.path}
                added={diff.added}
                removed={diff.removed}
                synthesized={diff.synthesized}
              />
            </section>
          ) : null}

          {result?.screenshot ? (
            <section>
              <h4 className="ob-tool-label">Screen</h4>
              <img className="ob-tool-shot" src={pngSrc(result.screenshot)} alt={`Screen capture from ${call.name}`} />
            </section>
          ) : null}

          {output ? (
            <section>
              <h4 className="ob-tool-label">Output</h4>
              <pre className="ob-tool-output">{clipped ? `${output.slice(0, OUTPUT_LIMIT)}\n… output truncated` : output}</pre>
            </section>
          ) : null}

          {!result ? <p className="ob-tool-pending">Waiting for the tool to finish…</p> : null}
          {/* A tool may return a chart to draw. Nothing read `detail` before,
              so the `visualize` tool produced a result and rendered nothing. */}
          {chart ? (
            <ErrorBoundary label="This chart could not be drawn">
              <Visualization spec={chart} source={call.name} />
            </ErrorBoundary>
          ) : null}

          {result && !result.ok && !output ? <p className="ob-tool-failed">The tool reported a failure.</p> : null}
        </div>
      ) : null}
    </div>
  )
}
