import type { ReactNode } from 'react'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { store, useAppState } from '../state'
import { ComputerFrame } from './ComputerFrame'
import { IconClose } from './Icons'
import { TodoList } from './TodoList'
import './RightRail.css'

/** Side panel: what the agent is doing, and what it has left to do. */
export function RightRail(): ReactNode {
  const { todos, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'

  return (
    <aside className="ob-rail" aria-label={zh ? '活动' : 'Activity'}>
      <div className="ob-rail-head">
        <span className="ob-rail-head-title">{zh ? '活动' : 'Activity'}</span>
        <button type="button" className="ob-icon-btn" aria-label={zh ? '关闭活动面板' : 'Hide the side panel'} onClick={() => store.toggleRail()}>
          <IconClose size={12} />
        </button>
      </div>
      <div className="ob-rail-scroll">
        <ComputerFrame />
        <TodoList todos={todos} />
      </div>
    </aside>
  )
}
