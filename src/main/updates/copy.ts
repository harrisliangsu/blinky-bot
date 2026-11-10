/** Dialog and notification copy for the update offer. Settings has its own strings. */

export type UpdateLang = 'en' | 'zh-CN'

export interface UpdateCopy {
  notifyTitle: string
  notifyBody: string
  offerTitle: string
  offerMessage: string
  upToDateTitle: string
  upToDateMessage: string
  emptyTitle: string
  noBeta: string
  emptyFeed: string
  errorTitle: string
  downloadingTitle: string
  downloadingBody: string
  readyTitle: string
  readyMessage: string
  installFailedTitle: string
  notPackaged: string
  badSignature: string
  badLength: string
  notInstallable: string
  installFailed: string
  buttons: {
    install: string
    open: string
    later: string
    skip: string
    relaunch: string
    notNow: string
    ok: string
  }
}

const en: UpdateCopy = {
  notifyTitle: 'BlinkyBot {version} is available',
  notifyBody: 'Open this notification to review and install it.',
  offerTitle: 'A new version of BlinkyBot is available',
  offerMessage: 'BlinkyBot {version} is available. You have {current}.',
  upToDateTitle: 'You’re up to date',
  upToDateMessage: 'BlinkyBot {version} is the newest version.',
  emptyTitle: 'No update',
  noBeta: 'No beta release is published.',
  emptyFeed: 'The update feed had no version.',
  errorTitle: 'Could not check for updates',
  downloadingTitle: 'Downloading BlinkyBot {version}…',
  downloadingBody: 'You can keep using BlinkyBot. It will ask before it installs.',
  readyTitle: 'Ready to install',
  readyMessage: 'BlinkyBot {version} was downloaded and its signature matches. BlinkyBot will quit, replace this copy, and relaunch.',
  installFailedTitle: 'The update could not be installed',
  notPackaged: 'Download and install runs from the installed BlinkyBot app on this Mac.',
  badSignature: 'The update signature did not match. Nothing was installed.',
  badLength: 'The downloaded update was the wrong size. Nothing was installed.',
  notInstallable: 'This update has no signed archive to install.',
  installFailed: 'The update could not be installed.',
  buttons: {
    install: 'Download and Install',
    open: 'Open release',
    later: 'Later',
    skip: 'Skip This Version',
    relaunch: 'Install and Relaunch',
    notNow: 'Not Now',
    ok: 'OK'
  }
}

const zh: UpdateCopy = {
  notifyTitle: 'BlinkyBot {version} 可以更新',
  notifyBody: '点按这条通知即可查看并安装。',
  offerTitle: 'BlinkyBot 有新版本',
  offerMessage: 'BlinkyBot {version} 可以安装。当前版本是 {current}。',
  upToDateTitle: '已是最新版本',
  upToDateMessage: 'BlinkyBot {version} 已是最新版本。',
  emptyTitle: '没有更新',
  noBeta: '还没有测试版。',
  emptyFeed: '更新源里没有版本。',
  errorTitle: '无法检查更新',
  downloadingTitle: '正在下载 BlinkyBot {version}…',
  downloadingBody: '可以继续使用。安装前还会再问一次。',
  readyTitle: '可以安装',
  readyMessage: 'BlinkyBot {version} 已下载，签名核对通过。应用会退出、替换当前副本并重新打开。',
  installFailedTitle: '更新未能安装',
  notPackaged: '下载并安装只在这台 Mac 上已安装的 BlinkyBot 里进行。',
  badSignature: '更新签名不一致，没有安装任何文件。',
  badLength: '下载的更新大小不对，没有安装任何文件。',
  notInstallable: '这次更新没有可安装的签名压缩包。',
  installFailed: '更新未能安装。',
  buttons: {
    install: '下载并安装',
    open: '打开发布页',
    later: '稍后',
    skip: '跳过此版本',
    relaunch: '安装并重新打开',
    notNow: '暂不',
    ok: '好'
  }
}

export function updateCopy(lang: UpdateLang): UpdateCopy {
  return lang === 'zh-CN' ? zh : en
}

export function updateLanguage(preference: string | undefined, systemLang: string): UpdateLang {
  if (preference === 'en' || preference === 'zh-CN') return preference
  return systemLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function fillUpdate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '')
}
