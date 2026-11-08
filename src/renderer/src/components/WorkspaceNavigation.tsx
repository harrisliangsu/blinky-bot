import type { ReactNode } from 'react'
import { openBoard, openProjectEditor, selectProject, store, toggleWorkspace, useAppState } from '../state'
import { openSettings } from '../lib/settingsNavigation'
import { Modal } from './Modal'

/** The same routes on Mac and touch devices; no keyboard is needed to reach a workspace. */
export function WorkspaceNavigation(): ReactNode {
  const { projects, settings, workspace, projectHome } = useAppState()
  const zh = settings?.language !== 'en'
  const go = (action: () => void): void => { store.setModal(null); action() }
  return <Modal title={zh ? '工作区' : 'Workspace'} size="sm" onClose={() => store.setModal(null)}>
    <div className="ob-workspace-navigation">
      <div className="ob-navigation-actions">
        <button type="button" className="ob-btn" onClick={() => store.setModal('bots')}>{zh ? '管理 Bot' : 'Manage bots'}</button>
        <button type="button" className="ob-btn" onClick={() => store.setModal('routines')}>{zh ? '例程与定时任务' : 'Routines and schedules'}</button>
        <button type="button" className="ob-btn" onClick={() => store.setModal('activity')}>{zh ? '动态与后台任务' : 'Activity and background tasks'}</button>
        <button type="button" className="ob-btn" onClick={() => store.setModal('palette')}>{zh ? '搜索与快捷操作' : 'Search and commands'}</button>
        <button type="button" className="ob-btn" onClick={() => go(toggleWorkspace)}>{workspace.open && !projectHome ? (zh ? '返回单个聊天' : 'Single chat') : (zh ? '并排聊天' : 'Multiple chats')}</button>
        <button type="button" className="ob-btn" onClick={() => go(() => openSettings())}>{zh ? '设置' : 'Settings'}</button>
      </div>
      <section className="ob-navigation-projects"><h3>{zh ? '项目与看板' : 'Projects and boards'}</h3>
        {projects.length ? projects.map(project => <div className="ob-navigation-project" key={project.id}>
          <button type="button" className="ob-btn" onClick={() => go(() => selectProject(project.id))}>{project.emoji} {project.name}</button>
          <button type="button" className="ob-btn" onClick={() => void openBoard(project.id)}>{zh ? '看板' : 'Board'}</button>
          <button type="button" className="ob-btn" onClick={() => openProjectEditor(project.id)}>{zh ? '修改' : 'Edit'}</button>
        </div>) : <p className="ob-hint">{zh ? '还没有项目，可新建项目整理聊天与看板。' : 'Create a project to organize chats and boards.'}</p>}
        <button type="button" className="ob-btn" onClick={() => openProjectEditor('new')}>{zh ? '新建项目' : 'New project'}</button>
      </section>
    </div>
  </Modal>
}
