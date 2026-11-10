import type { ReactNode } from 'react'
import type { TodoItem } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useAppState } from '../state'
import { IconCheck, IconSpinner } from './Icons'
import './TodoList.css'

interface TodoListProps {
  todos: TodoItem[]
}

const STATUS_LABEL: Record<TodoItem['status'], [string, string]> = {
  pending: ['待处理', 'Pending'],
  in_progress: ['进行中', 'In progress'],
  completed: ['已完成', 'Completed']
}

/** The agent's working checklist for the current session. */
export function TodoList({ todos }: TodoListProps): ReactNode {
  const { settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  if (todos.length === 0) {
    return (
      <section className="ob-todos" aria-label={zh ? '任务列表' : 'Task list'}>
        <h3 className="ob-rail-title">{zh ? '任务' : 'Tasks'}</h3>
        <p className="ob-todos-empty">{zh ? '暂无任务。Bot 制定计划后会在这里显示。' : 'No tasks yet. The bot adds them as it plans work.'}</p>
      </section>
    )
  }

  const done = todos.filter((t) => t.status === 'completed').length

  return (
    <section className="ob-todos" aria-label={zh ? '任务列表' : 'Task list'}>
      <h3 className="ob-rail-title">
        {zh ? '任务' : 'Tasks'}
        <span className="ob-todos-count">
          {done}/{todos.length}
        </span>
      </h3>
      <ol className="ob-todos-list">
        {todos.map((todo) => (
          <li key={todo.id} className={`ob-todo ob-todo-${todo.status}`}>
            <span className="ob-todo-mark" aria-hidden="true">
              {todo.status === 'completed' ? <IconCheck size={11} /> : null}
              {todo.status === 'in_progress' ? <IconSpinner size={11} /> : null}
            </span>
            <span className="ob-todo-text">{todo.text}</span>
            <span className="ob-sr-only">{STATUS_LABEL[todo.status][zh ? 0 : 1]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
