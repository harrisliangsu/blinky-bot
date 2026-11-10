/**
 * Everything that has to be torn down before the process goes away.
 *
 * The child processes OpenBOT starts — pooled agent-CLI servers, per-bot Chrome
 * instances — outlive the app if nobody stops them, so quitting leaves orphans
 * holding ports and profile locks that the next launch then fights with.
 *
 * The owning modules are reached the same way the rest of the main process
 * reaches its optional peers: `import.meta.glob` compiles to an empty map when
 * the file is absent, so a build without the agent or tool layer still quits
 * cleanly, and neither module is pulled into the startup path just to be
 * available at the end of it.
 */

/** How long a child gets to stop before the quit stops waiting for it. */
const STOP_DEADLINE_MS = 3000

type Stopper = () => Promise<void> | void

interface ShutdownTask {
  label: string
  /** Export to call on the resolved module. */
  fn: string
  candidates: Record<string, () => Promise<unknown>>
}

const TASKS: ShutdownTask[] = [
  {
    label: 'active agent runs',
    fn: 'shutdown',
    // @ts-ignore `import.meta.glob` is a Vite build-time transform.
    candidates: (typeof import.meta.glob === 'function' ? import.meta.glob('../agent/loop.ts') : { ['../agent/loop.ts']: () => import('../agent/loop.ts') }) as Record<string, () => Promise<unknown>>
  },
  {
    label: 'agent CLI servers',
    fn: 'stopAgentCliServers',
    // @ts-ignore `import.meta.glob` is a Vite build-time transform.
    candidates: (typeof import.meta.glob === 'function' ? import.meta.glob('../backends/cli/serverPool.ts') : { ['../backends/cli/serverPool.ts']: () => import('../backends/cli/serverPool.ts') }) as Record<
      string,
      () => Promise<unknown>
    >
  },
  {
    label: 'browsers',
    fn: 'stopAllBrowsers',
    // @ts-ignore `import.meta.glob` is a Vite build-time transform.
    candidates: (typeof import.meta.glob === 'function' ? import.meta.glob('../tools/computer/browser/registry.ts') : { ['../tools/computer/browser/registry.ts']: () => import('../tools/computer/browser/registry.ts') }) as Record<
      string,
      () => Promise<unknown>
    >
  },
  {
    label: 'provisional private boxes',
    fn: 'cleanupProvisionalAppleVms',
    // @ts-ignore `import.meta.glob` is a Vite build-time transform.
    candidates: (typeof import.meta.glob === 'function' ? import.meta.glob('../vm/appleVmSupervisor.ts') : { ['../vm/appleVmSupervisor.ts']: () => import('../vm/appleVmSupervisor.ts') }) as Record<string, () => Promise<unknown>>
  }
]

async function runTask(task: ShutdownTask): Promise<void> {
  const load = Object.values(task.candidates)[0]
  if (!load) return
  const module = (await load()) as Record<string, unknown>
  const stop = module[task.fn]
  if (typeof stop !== 'function') {
    console.warn(`[openbot] no ${task.fn} export; ${task.label} may be left running`)
    return
  }
  await (stop as Stopper)()
}

/** Resolve either way, but never later than the deadline. */
function withDeadline(work: Promise<void>, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Deliberately not `unref`ed: this timer is the thing that guarantees the
    // quit makes progress, so it has to be able to hold the loop open for it.
    const timer = setTimeout(() => {
      console.warn(`[openbot] gave up waiting for ${label} to stop`)
      resolve()
    }, STOP_DEADLINE_MS)
    void work
      .catch((err) => {
        console.error(`[openbot] could not stop ${label}`, err)
      })
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

/**
 * Stop every child process, in parallel, swallowing failures.
 *
 * A child that refuses to die — or hangs on the way out — must never block the
 * quit: leaking a process the OS will reap is far better than an app that will
 * not close. Failures are logged, never thrown.
 */
export async function stopChildProcesses(): Promise<void> {
  await Promise.all(TASKS.map((task) => withDeadline(runTask(task), task.label)))
}
