import { useState, type ReactNode } from 'react'
import type { SkillRuntimeCheck } from '../../../main/skills/runtime'

const LABELS: Record<SkillRuntimeCheck['status'], [string, string]> = {
  verified: ['已验证', 'Verified'], missing: ['未发现', 'Not found'], shadowed: ['同名副本优先', 'Another copy selected'],
  preserved: ['其他副本已保留', 'Other copy preserved'], stale: ['仍被发现，需检查', 'Still advertised; inspect'],
  unavailable: ['未安装或不可用', 'Unavailable'], unsupported: ['发现来源未验证', 'Source unverified'], error: ['验证失败', 'Verification failed']
}
const DETAILS: Record<SkillRuntimeCheck['status'], string> = {
  verified: '新启动的 CLI 已回读来源与当前内容；卸载时确认不再发现。', missing: '本轮原生发现没有返回该技能。',
  shadowed: 'CLI 返回了其他来源或多个同名副本；已有内容未被覆盖。', preserved: 'CLI 仍发现由其他工具管理的副本，已保留。',
  stale: 'CLI 仍返回已移除或不可读的路径，请核对。', unavailable: '未发现可用 CLI 或技能目录。',
  unsupported: '该 CLI 未提供受支持的来源路径；没有运行模型来猜测。', error: '原生发现启动失败、超时或来源不可读；未运行模型。'
}

export function SkillRuntimeResults({ checks, zh }: { checks: SkillRuntimeCheck[]; zh: boolean }): ReactNode {
  const [limit, setLimit] = useState(30)
  if (!checks.length) return null
  return <details className="ob-skill-detail" open data-skill-verification="">
    <summary>{zh ? '本次操作的 CLI 发现验证' : 'Native discovery for this operation'}</summary>
    <p className="ob-hint">{zh ? '逐项显示新探测结果。目录链接、CLI 发现与执行技能是不同的验证范围。' : 'Fresh results per CLI. Directory links, native discovery and skill execution are separate checks.'}</p>
    <ul className="ob-skill-list">{checks.slice(0, limit).map((check) => <li className="ob-skill-row" key={`${check.skill}:${check.agent}`}>
      <div className="ob-skill-text"><strong>{check.agent} · {check.skill}</strong><p className="ob-hint">{zh ? DETAILS[check.status] : check.detail}</p></div>
      <span className="ob-pill">{LABELS[check.status][zh ? 0 : 1]}</span>
    </li>)}</ul>
    {checks.length > limit ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setLimit((value) => value + 30)}>{zh ? `显示更多（剩余 ${checks.length - limit} 项）` : `Show more (${checks.length - limit} remaining)`}</button> : null}
  </details>
}
