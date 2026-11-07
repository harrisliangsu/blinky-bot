/** Local, independently written starting points. A template is always editable before creating a Bot. */
export interface BotTemplate {
  id: string
  category: 'development' | 'research' | 'writing' | 'planning'
  name: string
  description: string
  emoji: string
  color: string
  systemPrompt: string
  tools: string[]
}

const readTools = ['read_file', 'list_dir', 'glob', 'grep', 'request_help']
const workTools = [...readTools, 'write_file', 'edit_file', 'shell', 'todo_write']

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  { id: 'code-builder', category: 'development', name: '代码开发', description: '在项目中实现和验证需求。', emoji: '🛠️', color: '#5ad1a5', systemPrompt: '你负责软件开发。先理解现有代码和约束，再实现用户需要的行为；运行合适的检查，并说明结果和限制。', tools: workTools },
  { id: 'code-review', category: 'development', name: '代码审阅', description: '查找改动中的问题并说明触发条件。', emoji: '🔎', color: '#7c9cff', systemPrompt: '你负责审阅代码。结合调用路径找出有实际影响的问题，说明触发条件、后果和证据；区分事实与推测。', tools: readTools },
  { id: 'test-helper', category: 'development', name: '测试检查', description: '设计并执行适合当前改动的检查。', emoji: '🧪', color: '#f7ae64', systemPrompt: '你负责验证软件行为。先确定要验证的用户路径，再运行必要检查，准确报告通过、失败和未覆盖的范围。', tools: workTools },
  { id: 'research', category: 'research', name: '资料研究', description: '整理证据并标注来源和不确定性。', emoji: '📚', color: '#bc91ef', systemPrompt: '你负责研究。优先读取原始资料，给重要事实附上来源，区分材料直接支持的内容与自己的推断。', tools: [...readTools, 'fetch', 'web_search', 'write_file'] },
  { id: 'data-analysis', category: 'research', name: '数据分析', description: '检查数据并解释结果与限制。', emoji: '📊', color: '#5ad1a5', systemPrompt: '你负责数据分析。先检查数据来源和口径，再选择合适方法；说明计算、假设与结论的适用范围。', tools: workTools },
  { id: 'writing', category: 'writing', name: '写作编辑', description: '根据目标读者起草和修改文字。', emoji: '✍️', color: '#f7ae64', systemPrompt: '你负责写作和编辑。保留用户意图与语气，清楚组织内容，并根据需要说明重要修改。', tools: [...readTools, 'write_file', 'edit_file'] },
  { id: 'planner', category: 'planning', name: '任务规划', description: '拆分目标、依赖和可验证的完成条件。', emoji: '📋', color: '#7c9cff', systemPrompt: '你负责把目标转化为可执行计划。说明依赖、优先级和验证方式；不替用户作未经授权的外部承诺。', tools: [...readTools, 'todo_write', 'write_file'] },
  { id: 'organizer', category: 'planning', name: '工作整理', description: '从已有资料中整理待办和摘要。', emoji: '🗂️', color: '#bc91ef', systemPrompt: '你负责整理用户提供的工作材料。保留来源，区分待办与已完成，并对缺失的信息明确标记。', tools: [...readTools, 'todo_write', 'write_file'] }
]

export function findBotTemplates(query: string): BotTemplate[] {
  const needle = query.trim().toLocaleLowerCase()
  return BOT_TEMPLATES.filter((template) => !needle || `${template.name} ${template.description} ${template.category}`.toLocaleLowerCase().includes(needle))
}
