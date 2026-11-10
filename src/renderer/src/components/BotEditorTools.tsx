import type { ReactNode } from 'react'
import type { ToolId } from '../../../shared/types'
import { useBotChinese } from './BotUiLanguage'

/**
 * The groups follow the sections `TOOL_IDS` itself is written in. Typed as
 * `ToolId`, so a renamed or mistyped id fails the build here rather than
 * rendering a checkbox that grants a tool no registry can run.
 */
const TOOL_GROUPS: Array<{ label: string; ids: ToolId[] }> = [
  { label: 'Files & code', ids: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell'] },
  { label: 'Web', ids: ['fetch', 'web_search'] },
  { label: 'Computer', ids: ['screenshot', 'click', 'type_text', 'key_press', 'scroll', 'drag', 'open_app', 'navigate'] },
  /*
   * `visualize` was in `TOOL_IDS` and in the registry but in no group, and
   * `schemasFor` only advertises a tool the bot has been granted — so it could
   * never be granted from here, and a bot that somehow carried it showed no
   * trace of it either, because the hint below only named ids from outside the
   * contract. It draws a chart in the transcript and reads, writes and runs
   * nothing, so it belongs beside the other presentation-only work.
   */
  { label: 'Presentation', ids: ['visualize'] },
  { label: 'Bot', ids: ['todo_write', 'remember', 'handoff', 'delegate_task', 'request_help'] },
  { label: 'Routines', ids: ['schedule_routine', 'watch_github_issue', 'watch_gmail_query', 'create_webhook_routine'] },
  { label: 'Connected apps', ids: ['github_comment_draft', 'search_gmail', 'read_gmail', 'gmail_draft', 'list_calendar_events', 'calendar_event_draft', 'read_x_post', 'x_post_draft', 'slack_message_draft'] }
]

/*
 * Measured against what the groups actually render, not against `TOOL_IDS`: an
 * id the contract has but no group lists is exactly how `visualize` went
 * invisible, so the hint now names it instead of hiding it.
 */
const GROUPED_IDS: ReadonlySet<string> = new Set(TOOL_GROUPS.flatMap((group) => group.ids))

const TOOL_LABELS_ZH: Partial<Record<ToolId, string>> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件', list_dir: '浏览目录',
  glob: '查找文件', grep: '搜索内容', shell: '运行命令', fetch: '读取网页', web_search: '搜索网页',
  screenshot: '截取屏幕', click: '点击', type_text: '输入文字', key_press: '按键', scroll: '滚动',
  drag: '拖动', open_app: '打开应用', navigate: '浏览页面', visualize: '生成图表',
  todo_write: '管理待办', remember: '保存记忆', handoff: '交接任务', delegate_task: '派发任务', request_help: '请求协助',
  schedule_routine: '创建定时例程', watch_github_issue: '监听 GitHub 工单', watch_gmail_query: '监听 Gmail 查询', create_webhook_routine: '创建 Webhook 例程',
  github_comment_draft: 'GitHub 评论草稿', search_gmail: '搜索 Gmail', read_gmail: '读取 Gmail', gmail_draft: '邮件草稿',
  list_calendar_events: '读取日历', calendar_event_draft: '日程草稿', read_x_post: '读取 X 帖子', x_post_draft: 'X 帖子草稿', slack_message_draft: 'Slack 消息草稿'
}

interface ToolsProps {
  tools: string[]
  onToggle: (id: string) => void
}

/** The tool grant, grouped the way the tools themselves are. */
export function BotEditorTools({ tools, onToggle }: ToolsProps): ReactNode {
  const zh = useBotChinese()
  const ungroupedTools = tools.filter((id) => !GROUPED_IDS.has(id))
  const groupNames: Record<string, string> = { 'Files & code': '文件与代码', Web: '网络', Computer: '电脑', Presentation: '展示', Bot: 'Bot 协作', Routines: '例程', 'Connected apps': '已连接应用' }

  return (
    <div className="ob-field">
      <p className="ob-hint">{zh ? '选择此 Bot 可调用的应用内工具。CLI 自带工具的权限由各 CLI 控制。' : 'Choose app-managed tools. Each CLI controls its own built-in tools.'}</p>
      <p className="ob-hint">{zh ? '连接应用后，请在下方为此 Bot 勾选需要使用的工具；原先通过派发任务使用的应用和例程工具也需要勾选。' : 'After connecting an app, select the tools this Bot may use below. App and routine tools previously available through delegation also need to be selected.'}</p>
      {TOOL_GROUPS.map((group) => (
        <fieldset key={group.label} className="ob-bot-tools">
          <legend>{zh ? groupNames[group.label] : group.label}</legend>
          {group.ids.map((id) => (
            <label key={id} className="ob-check" title={id}>
              <input type="checkbox" checked={tools.includes(id)} onChange={() => onToggle(id)} />
              <span>{zh ? TOOL_LABELS_ZH[id] ?? id : id.replaceAll('_', ' ')}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {ungroupedTools.length > 0 ? <p className="ob-hint">{zh ? '其他已启用工具：' : 'Also enabled: '}{ungroupedTools.join(', ')}</p> : null}
    </div>
  )
}
