// A real, local-only operation for the controlled result-completion fixture.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const contract = Object.freeze({
  relativePath: 'src/export/synthetic-placeholder.md',
  timeZone: 'Asia/Singapore',
  fields: ['synthetic_id', 'occurred_at'],
  headings: ['第一步：字段', '第二步：时区', '第三步：样例'],
  sample: { synthetic_id: 'synthetic-001', occurred_at: '2026-11-08T08:00:00+08:00' }
})
const userRequest = `安排一次合成任务流验收：只交付 ${contract.relativePath}，醒目标注“仅用于合成任务流验收”。正文严格分“${contract.headings.join('”、“')}”三节：列出 ${contract.fields.join('、')} 两个合成占位字段及用途；时区明确为 ${contract.timeZone}（UTC+08:00，不读取系统或业务时区）；给出与字段和时区一致的完全虚构样例。只创建这一份 Markdown 文档，不开发真实功能，不连接业务数据。执行者须实际写入并用独立操作回读，返回路径、三个标题、字段、时区、样例、SHA-256 和操作记录。返回后按这些明确要求核对。`

function document() {
  return '# 合成占位说明\n\n仅用于合成任务流验收；所有字段和值均为虚构，不连接真实业务。\n\n' +
    `## ${contract.headings[0]}\nsynthetic_id：虚构的合成记录标识。occurred_at：仅演示时区偏移的合成时间，不代表真实业务字段。\n\n` +
    `## ${contract.headings[1]}\n本合成说明固定采用 ${contract.timeZone}（UTC+08:00）；不读取系统或业务时区，不代表真实业务配置。\n\n` +
    `## ${contract.headings[2]}\n完全虚构、非真实业务数据：\n\n${JSON.stringify(contract.sample, null, 2)}\n`
}

function checkedTarget(root, workspace, relativePath = contract.relativePath) {
  const realRoot = fs.realpathSync(root), realWork = fs.realpathSync(workspace)
  const contains = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)) }
  assert.ok(contains(realRoot, realWork), 'The workspace must belong to this synthetic test root')
  assert.equal(relativePath, contract.relativePath, 'Only the fixed synthetic deliverable is allowed')
  const target = path.resolve(realWork, relativePath)
  assert.ok(contains(realWork, target), 'The synthetic file must stay in its workspace')
  // Refuse symlink escapes before either creating a directory or reading a file.
  let ancestor = target
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  assert.ok(contains(realWork, fs.realpathSync(ancestor)), 'A symlink must not escape the synthetic workspace')
  return target
}

function operate(mode, root, workspace) {
  assert.ok(['write', 'read'].includes(mode), 'Unsupported controlled operation')
  const target = checkedTarget(root, workspace)
  if (mode === 'write') {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, document(), { mode: 0o600 })
  }
  const bytes = fs.readFileSync(checkedTarget(root, workspace))
  assert.equal(bytes.toString(), document(), 'The actual file must meet the exact synthetic contract')
  return { mode, synthetic: true, path: target, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    headings: [...contract.headings], fields: [...contract.fields], timeZone: contract.timeZone, sample: contract.sample, readBack: bytes.toString() }
}

module.exports = { contract, userRequest, document, checkedTarget, operate }
if (require.main === module) {
  try { console.log(JSON.stringify(operate(process.argv[2], process.argv[3], process.cwd()))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
