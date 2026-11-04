import type { ReactNode } from 'react'
import type { TodoItem } from '../../../shared/types'
import { IconCheck, IconSpinner } from './Icons'
import './TodoList.css'

interface TodoListProps {
  todos: TodoItem[]
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed'
}

/** The agent's working checklist for the current session. */
export function TodoList({ todos }: TodoListProps): ReactNode {
  if (todos.length === 0) {
    return (
      <section className="ob-todos" aria-label="Task list">
        <h3 className="ob-rail-title">Tasks</h3>
        <p className="ob-todos-empty">No tasks yet. The bot adds them as it plans work.</p>
      </section>
    )
  }

  const done = todos.filter((t) => t.status === 'completed').length

  return (
    <section className="ob-todos" aria-label="Task list">
      <h3 className="ob-rail-title">
        Tasks
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
            <span className="ob-sr-only">{STATUS_LABEL[todo.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
