import { randomId } from '../lib/randomId'
import { useRef, useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import type { PermissionEdit, PermissionRuleList } from '../../../shared/settings'
import { isSemanticPermissionRule, type SemanticPermissionRule } from '../../../shared/permissionRules'
import { localExecutionPolicy } from '../../../shared/localExecution'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { FormDialog } from './FormDialog'
import './SettingsPermissions.css'

async function save(edit: PermissionEdit): Promise<void> {
  const result = await window.openbot.settings.editPermission(edit)
  if (!result.ok) throw new Error(result.error)
  // The main process publishes settings-updated before replying. Replacing
  // that event with this response could roll back a newer concurrent setting.
}

export function LocalExecutionControl({ settings }: { settings: Settings }): ReactNode {
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <section className="ob-set-card ob-permissions-card">
    <div className="ob-permission-heading">
      <div><h3>{zh ? '在这台电脑上执行' : 'Run on this computer'}</h3>
        <p className="ob-hint">{zh ? '允许 Bot 访问本机文件并运行任务。禁止规则、需要确认的操作和 macOS 系统授权继续生效。' : 'Allow Bots to access local files and run tasks. Deny rules, required confirmations and macOS permissions still apply.'}</p>
      </div>
      <select className="ob-select ob-settings-select" aria-label={zh ? '本机执行方式' : 'Local execution policy'}
        value={localExecutionPolicy(settings)} disabled={busy}
        onChange={(event) => {
          setBusy(true); setError('')
          void save({kind:'options',localExecutionPolicy:event.target.value as NonNullable<Settings['localExecutionPolicy']>})
            .catch(e=>setError(String(e.message))).finally(()=>setBusy(false))
        }}>
        <option value="always-allow">{zh ? '始终允许' : 'Always allow'}</option>
        <option value="ask-every-time">{zh ? '每次询问' : 'Ask every time'}</option>
        <option value="never-allow">{zh ? '从不允许' : 'Never allow'}</option>
      </select>
    </div>
    <p className="ob-hint">{zh
      ? '每次询问：每次受控操作都由你确认，允许规则不会跳过询问；原生 CLI 每轮任务先确认，内部工具无法全部逐项拦截。从不允许会阻止本机工具和有本机能力的原生任务；经验证无工具的模型推理仍可使用。'
      : 'Ask every time requires your approval for each controlled app action and native CLI task. Saved allows never skip confirmation. Internal CLI tools cannot all be intercepted. Never allow blocks local tools and native tasks with host capabilities; verified tool-free model inference remains available.'}</p>
    {settings.approvalPolicy === 'ask-first-time' || settings.approvalPolicy === 'allowlist' ? <p className="ob-hint">{zh ? '原“首次询问／按已有允许规则”已安全转为每次询问；旧规则和配置仍保留。' : 'Legacy first-time / allow-rule policies migrate to asking every time. Existing rules and configuration are retained.'}</p> : null}
    {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
  </section>
}

type Editor = { list: PermissionRuleList; previous?: string; semantic?: SemanticPermissionRule; format: 'semantic' | 'pattern' }

/** Actual permission rules, rather than prompt instructions. All edits use a dialog. */
export function SettingsPermissions({ settings }: { settings: Settings }): ReactNode {
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [editor, setEditor] = useState<Editor | null>(null)
  const saving = useRef(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const labels: Record<PermissionRuleList,string> = {
    asklist: zh ? '始终询问' : 'Always ask', allowlist: zh ? '无需询问直接允许' : 'Allow without asking',
    denylist: zh ? '始终拒绝' : 'Always deny', computerUseAllowedApps: zh ? '允许控制的应用' : 'Apps allowed for computer use'
  }
  function open(list:PermissionRuleList,previous?:string):void {if(busy||saving.current)return;setEditor({list,previous,format:!previous&&(list==='asklist'||list==='allowlist')?'semantic':'pattern'});setValue(previous??'');setError('')}
  function openSemantic(rule:SemanticPermissionRule):void {if(busy||saving.current)return;setEditor({list:rule.effect==='ask'?'asklist':'allowlist',semantic:rule,format:'semantic'});setValue(rule.text);setError('')}
  function close():void {if(busy||saving.current)return;setEditor(null);setError('')}
  async function commit(remove=false):Promise<void> {
    if (!editor || busy || saving.current) return
    // Close/repeated clicks must not detach a draft from an in-flight durable edit.
    saving.current=true;setBusy(true);setError('')
    try {
      if(editor.format==='semantic')await save({kind:'semantic-rule',rule:{id:editor.semantic?.id??randomId(),version:1,effect:editor.list==='asklist'?'ask':'allow',text:value},previous:editor.semantic,remove})
      else await save({kind:'rule',list:editor.list,previous:editor.previous,value:remove?editor.previous!:value,remove})
      setEditor(null)
    }
    catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{saving.current=false;setBusy(false)}
  }
  function rules(list:PermissionRuleList,hint:string):ReactNode {
    const items=settings[list]??[]
    const semantic=Array.isArray(settings.semanticPermissionRules)?settings.semanticPermissionRules.filter(isSemanticPermissionRule).filter(rule=>rule.effect===(list==='asklist'?'ask':list==='allowlist'?'allow':'')):[]
    return <section className="ob-permission-rules" aria-label={labels[list]}>
      <div className="ob-permission-heading"><div><h3>{labels[list]}</h3><p className="ob-hint">{hint}</p></div>
        <button type="button" className="ob-btn ob-btn-sm" data-permission-add={list} disabled={busy} onClick={()=>open(list)}>{zh?'添加规则':'Add rule'}</button>
      </div>
      {semantic.length?<div className="ob-permission-rule-list">{semantic.map(rule=><button type="button" key={rule.id} className="ob-permission-rule" disabled={busy} onClick={()=>openSemantic(rule)} aria-label={`${zh?'编辑':'Edit'} ${rule.text}`}><span>{rule.text}</span><span>{zh?'语义规则':'Meaning'} ›</span></button>)}</div>:null}
      {items.length ? <div className="ob-permission-rule-list">{items.map(item=><button type="button" key={item}
        className="ob-permission-rule" disabled={busy} onClick={()=>open(list,item)} aria-label={`${zh?'编辑':'Edit'} ${item}`}>
        <span>{item}</span><span aria-hidden="true">{list==='asklist'||list==='allowlist'?(zh?'模式匹配':'Pattern'):''} ›</span>
      </button>)}</div> : null}
    </section>
  }
  return <div className="ob-settings-section ob-permissions-layout">
    <section className="ob-set-card ob-permissions-card ob-permission-heading">
      <div><h3>{zh?'自动审核':'Automatic review'}</h3><p className="ob-hint">{zh?'新增自然语言规则后，使用所属 Bot 当前模型审核具体操作；无法安全审核或匹配不确定时询问你。关闭后由你确认，规则保留。':'Natural-language rules use the owning Bot’s current model to review the exact action. Unavailable or uncertain review asks you. When off, you confirm actions; rules are retained.'}</p></div>
      <button type="button" role="switch" aria-label={zh?'自动审核':'Automatic review'} aria-checked={settings.automaticReview!==false}
        className={`ob-switch${settings.automaticReview!==false?' is-on':''}`} disabled={busy}
        onClick={()=>{setBusy(true);setError('');void save({kind:'options',automaticReview:settings.automaticReview===false}).catch(e=>setError(String(e.message))).finally(()=>setBusy(false))}} />
    </section>
    {error&&!editor?<p role="alert" className="ob-notice ob-notice-error">{error}</p>:null}
    {rules('asklist',zh?'操作与这些规则匹配时，停下来询问。':'Pause and ask when an action matches these rules.')}
    {rules('allowlist',zh?'自动审核开启时，匹配的操作可自动继续；不能覆盖本机“每次询问／从不允许”、“始终询问”规则、禁止规则或必要确认。':'Matching actions can proceed during automatic review. Ask every time, Never allow, always-ask rules, deny rules and mandatory confirmations take priority.')}
    {(settings.denylist.length>0)?rules('denylist',zh?'已有明确禁止会继续阻止执行，不会改为“询问”。':'Existing explicit denials still block execution; they do not become ask rules.'):null}
    <p className="ob-hint">{zh?'“始终允许”授予本机资源访问范围。添加自然语言规则后，自动审核可继续安全操作；允许规则可放行范围明确的待审操作。明确禁止、必要确认、“始终询问”规则及本机“每次询问／从不允许”优先。':'Always allow grants access to local resources. With natural-language rules, automatic review can continue safe actions; matching allows can pass understood actions needing review. Denials, mandatory confirmation, always-ask rules, Ask every time and Never allow take priority.'}</p>
    <details className="ob-permission-details"><summary>{zh?'电脑控制与禁止规则':'Computer control and deny rules'}</summary>
      {!settings.denylist.length?rules('denylist',zh?'这些规则直接拒绝操作。':'These rules refuse the action.'):null}
      {rules('computerUseAllowedApps',zh?'仅用于已启用电脑控制的 Bot；还需要 macOS 屏幕录制和辅助功能授权。':'Applies to Bots with computer use enabled. macOS Screen Recording and Accessibility permissions are still required.')}
    </details>
    <p className="ob-hint">{zh?'新规则默认按含义匹配，也可选择命令／路径模式。已有规则保留原匹配方式；不会自动改成自然语言。应用不能保证拦截第三方 CLI／MCP 的全部内部操作。':'New rules match meaning by default; command/path patterns are also available. Existing rules keep their original pattern semantics. The app cannot intercept all internal actions of third-party CLIs or MCP servers.'}</p>
    {editor?<FormDialog fallbackFocus={`[data-permission-add="${editor.list}"]`} size="sm" title={`${editor.previous||editor.semantic?(zh?'编辑规则':'Edit rule'):(zh?'添加规则':'Add rule')} · ${labels[editor.list]}`} onClose={close}
      actions={<button type="button" className="ob-btn ob-btn-primary" disabled={busy||!value.trim()} onClick={()=>void commit()}>{busy?(zh?'正在保存…':'Saving…'):(zh?'保存':'Save')}</button>}>
      {!editor.previous&&!editor.semantic&&(editor.list==='asklist'||editor.list==='allowlist')?<label className="ob-field"><span className="ob-label">{zh?'规则方式':'Match by'}</span><select className="ob-select" aria-label={zh?'规则方式':'Match by'} disabled={busy} value={editor.format} onChange={e=>setEditor({...editor,format:e.target.value as Editor['format']})}><option value="semantic">{zh?'自然语言含义':'Natural-language meaning'}</option><option value="pattern">{zh?'命令／路径模式':'Command/path pattern'}</option></select></label>:null}
      <label className="ob-field"><span className="ob-label">{editor.list==='computerUseAllowedApps'?(zh?'应用名称':'App name'):(zh?'匹配规则':'Match rule')}</span>
        <input className="ob-input" value={value} maxLength={2000} disabled={busy} onChange={event=>setValue(event.target.value)}
          placeholder={editor.list==='computerUseAllowedApps'?'Safari':editor.format==='semantic'?(zh?'例如：向远程仓库推送代码前询问':'For example: Ask before pushing code to a remote repository'):'git status * / tool:read_file / /Users/name/Documents/*'} />
      </label>
      <p className="ob-hint">{editor.format==='semantic'?(zh?'按语义审核当前操作；不读取额外文件。模型不可用、信息不足或规则含义不确定时由你确认。不能覆盖严格每次询问、拒绝及必要确认。':'Reviews the meaning of the current action without extra file access. Unavailable models, missing facts or uncertain matches ask you. Cannot override Ask every time, denials or mandatory confirmation.'):editor.list==='computerUseAllowedApps'?(zh?'填写实际应用名；这不会授予 macOS 系统权限。':'Use the actual app name. This does not grant macOS permissions.'):(zh?'填写实际命令、文件路径或 tool:工具名。精确文本或命令前缀匹配，* 匹配任意文本，? 匹配单个字符；已有正则规则仍兼容。':'Enter an actual command, file path or tool:tool_name. Exact text or command prefixes match; * matches any text and ? one character. Existing regular-expression rules remain compatible.')}</p>
      {error?<p role="alert" className="ob-notice ob-notice-error">{error}</p>:null}
      <div className="ob-permission-editor-actions"><button type="button" className="ob-btn" disabled={busy} onClick={close}>{zh?'取消':'Cancel'}</button>
        {editor.previous||editor.semantic?<button type="button" className="ob-btn ob-btn-danger" disabled={busy} onClick={()=>void commit(true)}>{zh?'删除规则':'Delete rule'}</button>:null}
      </div>
    </FormDialog>:null}
  </div>
}
