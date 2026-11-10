/** An Ego TaskSpace owned exclusively by this Bot, driven through the installed CLI. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputerProvider, MouseButton, ScreenFrame } from '../../../../shared/types'
import { hydratedEnv } from '../../../backends/loginShellEnv'
import { MAX_FRAME_WIDTH } from '../localCapture'
import { AppDock } from './apps'
import { parseCombo, editingCommands } from './keymap'
import { profileLayout } from './profile'
import { vaultFillExpression } from './vaultFill'
import { runEgoCommand } from './egoCli'

interface SpaceRecord { name: string; id?: number }
interface CdpCall { method: string; params: Record<string, unknown> }

export class EgoComputerProvider implements ComputerProvider {
  readonly kind = 'browser' as const
  private readonly file: string
  private readonly dock: AppDock
  private ready?: Promise<SpaceRecord>
  private queue: Promise<unknown> = Promise.resolve()
  private scale = 1

  constructor(readonly botId: string, dataDir?: string) {
    const layout = profileLayout(botId, dataDir)
    this.file = join(layout.root, 'ego-space.json')
    this.dock = new AppDock(layout.appsFile)
  }

  private async cli(script: string): Promise<unknown> {
    const env = await hydratedEnv()
    // Input may contain human-entered secrets. The runner never reports it or
    // raw process output in an error.
    return runEgoCommand(script, env)
  }

  private async init(): Promise<SpaceRecord> {
    await mkdir(join(this.file, '..'), { recursive: true })
    const proposed = `${this.file}.${randomUUID()}.tmp`
    await writeFile(proposed, JSON.stringify({ name: `blinky-${randomUUID()}` }), { flag: 'wx', mode: 0o600 })
    try { await link(proposed, this.file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally { await unlink(proposed).catch(() => undefined) }
    const record = JSON.parse(await readFile(this.file, 'utf8')) as SpaceRecord
    if (!/^blinky-[0-9a-f-]{36}$/.test(record.name) || (record.id !== undefined && (!Number.isSafeInteger(record.id) || record.id < 1))) throw new Error('The Bot browser ownership record is invalid.')
    const selector = record.id ?? record.name
    const found = await this.cli(`const task = await taskSpace(${JSON.stringify(selector)});\nconsole.log('__BLINKY_RESULT__'+JSON.stringify({id:task.spaceId,name:task.name}));\n`) as { id?: number; name?: string }
    if (!Number.isSafeInteger(found.id) || found.name !== record.name || (record.id !== undefined && found.id !== record.id)) throw new Error('The Ego Browser space does not match this Bot’s ownership record.')
    if (record.id === undefined) {
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ ...record, id: found.id }), { mode: 0o600 })
      await rename(temp, this.file)
    }
    return { name: record.name, id: found.id }
  }

  private async action<T>(body: string): Promise<T> {
    const execute = async (): Promise<T> => {
      this.ready ??= this.init().catch((error) => { this.ready = undefined; throw error })
      const record = await this.ready
      const script = `const task = await taskSpace(${JSON.stringify(record.id)});\nif (task.name !== ${JSON.stringify(record.name)}) throw Error('space ownership mismatch');\nconst page = task.page('p1');\n${body}\n`
      return await this.cli(script) as T
    }
    const next = this.queue.then(execute, execute)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async cdp(calls: CdpCall[]): Promise<void> {
    await this.action(`for (const call of ${JSON.stringify(calls)}) await page.cdp(call.method, call.params);\nconsole.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try { await this.action(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.url()));`); return { ok: true, detail: 'Ego Browser space is ready.' } }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'Ego Browser is unavailable.' } }
  }

  /** Focus only the page in this provider's verified, persisted TaskSpace. */
  async openForUser(): Promise<number> {
    return this.action<number>(`await page.cdp('Page.bringToFront');\nawait task.cdp('Target.activateTarget', {targetId:page.targetId});\nconsole.log('__BLINKY_RESULT__'+JSON.stringify(task.spaceId));`)
  }

  async screenshot(): Promise<ScreenFrame> {
    const result = await this.action<{ data: string; width: number; height: number }>(`const d = await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));\nconst scale = Math.min(1, ${MAX_FRAME_WIDTH}/d.width)/d.dpr;\nconst shot = await page.cdp('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:d.width,height:d.height,scale}});\nconsole.log('__BLINKY_RESULT__'+JSON.stringify({data:shot.data,width:d.width,height:d.height}));`)
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Ego Browser returned an invalid screenshot.')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    this.scale = width / result.width
    return { image: result.data, width, height, scale: this.scale }
  }

  async moveMouse(x: number, y: number): Promise<void> { await this.cdp([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: x / this.scale, y: y / this.scale, button: 'none' } }]) }
  async click(x: number, y: number, button: MouseButton = 'left', clickCount = 1): Promise<void> {
    const point = { x: x / this.scale, y: y / this.scale, button }
    const calls: CdpCall[] = [{ method: 'Input.dispatchMouseEvent', params: { ...point, type: 'mouseMoved' } }]
    const pressed = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    for (let i = 1; i <= clickCount; i++) for (const [type, buttons] of [['mousePressed', pressed], ['mouseReleased', 0]] as const) calls.push({ method: 'Input.dispatchMouseEvent', params: { ...point, type, buttons, clickCount: i } })
    await this.cdp(calls)
  }
  async typeText(text: string): Promise<void> { await this.cdp([{ method: 'Input.insertText', params: { text } }]) }
  async keyPress(combo: string): Promise<void> {
    const { modifiers, key, code, vk, text } = parseCombo(combo)
    const params = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    const commands = editingCommands(modifiers, key)
    await this.cdp([{ method: 'Input.dispatchKeyEvent', params: { ...params, type: text ? 'keyDown' : 'rawKeyDown', text, ...(commands.length ? { commands } : {}) } }, { method: 'Input.dispatchKeyEvent', params: { ...params, type: 'keyUp' } }])
  }
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> { await this.cdp([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: x / this.scale, y: y / this.scale, deltaX: dx * 40, deltaY: dy * 40, buttons: 0 } }]) }
  async drag(from: [number, number], to: [number, number]): Promise<void> {
    const [fx, fy] = from.map((v) => v / this.scale), [tx, ty] = to.map((v) => v / this.scale)
    const calls: CdpCall[] = [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: fx, y: fy, button: 'none' } }, { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1 } }]
    for (let i = 1; i <= 12; i++) calls.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: fx + (tx - fx) * i / 12, y: fy + (ty - fy) * i / 12, button: 'left', buttons: 1 } })
    calls.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1 } })
    await this.cdp(calls)
  }
  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error('A browser target can only navigate to http(s) URLs.')
    await this.action(`await page.goto(${JSON.stringify(url)});\nconsole.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  }
  /** The value travels only to the owned browser page, never the model or renderer. */
  async fillVaultField(origin: string, field: string, value: string): Promise<boolean> {
    const expression = vaultFillExpression(origin, field, value)
    return await this.action<boolean>(`const result = await page.evaluate(() => ${expression});\nconsole.log('__BLINKY_RESULT__'+JSON.stringify(result === true));`)
  }
  async openApp(name: string): Promise<void> {
    await this.dock.ready()
    const app = this.dock.find(name)
    if (!app) throw new Error(`No browser app named ${name} is available.`)
    await this.navigate(app.url)
  }
  async activeApp(): Promise<string | undefined> {
    const url = await this.action<string>(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.url()));`)
    try {
      const host = new URL(url).host
      await this.dock.ready()
      return this.dock.list().find((app) => { try { return new URL(app.url).host === host } catch { return false } })?.name ?? (host || undefined)
    } catch { return undefined }
  }
  async stop(): Promise<void> { await this.queue /* The owned space remains available for later sessions. */ }
}
