/**
 * Tool presets and the three starter personas seeded on first run, so the app
 * is never empty on launch. Deliberately generic — no personal details.
 */

import type { Bot, ComputerTarget, Settings } from '../../shared/types'

/** Starter bots drive this machine, not a VM. */
export const LOCAL_TARGET: ComputerTarget = { kind: 'local' }

/** What a new bot gets unless told otherwise. Computer-use tools are opt-in. */
export const DEFAULT_BOT_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'shell',
  'fetch',
  'todo_write',
  'remember',
  'handoff',
  'delegate_task',
  'request_help'
]

/** Read-and-gather rather than build-and-run. */
const RESEARCH_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'list_dir',
  'glob',
  'grep',
  'fetch',
  'web_search',
  'todo_write',
  'remember',
  'handoff',
  'delegate_task',
  'request_help'
]

export type BotSeed = Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>

/** Stable id for the general-purpose starter. Older files used a random id. */
export const SEEDED_GENERAL_BOT_ID = 'blinky'

/** Opening line of the general-purpose seed before it was renamed. */
export const SEEDED_ASSISTANT_LINE =
  'You are Assistant, the general-purpose bot inside BlinkyBot, a local-first desktop agent.'

const SEEDED_BLINKY_LINE =
  'You are Blinky, the general-purpose bot inside BlinkyBot, a local-first desktop agent.'

export type NamedSeed = BotSeed & { seedId?: string }

/**
 * Rename the seeded general-purpose bot from Assistant to Blinky.
 *
 * A bot the user renamed is left alone. A bot they created and happened to
 * call Assistant is left alone too: it has to be this seed's id, or — for a
 * file written before that id existed — still carry the original prompt line.
 */
export function migrateSeededAssistant<T extends { id: string; name: string; systemPrompt: string }>(bot: T): T | null {
  if (bot.name !== 'Assistant') return null
  const legacyPrompt = bot.systemPrompt.includes(SEEDED_ASSISTANT_LINE)
  if (bot.id !== SEEDED_GENERAL_BOT_ID && !legacyPrompt) return null
  const systemPrompt = legacyPrompt ? bot.systemPrompt.replaceAll(SEEDED_ASSISTANT_LINE, SEEDED_BLINKY_LINE) : bot.systemPrompt
  return { ...bot, name: 'Blinky', systemPrompt }
}

export function starterBots(settings: Settings): NamedSeed[] {
  const shared = {
    backendId: settings.defaultBackendId,
    modelId: settings.defaultModelId,
    followsDefault: true
  }

  return [
    {
      ...shared,
      seedId: SEEDED_GENERAL_BOT_ID,
      name: 'Blinky',
      description: 'The default general-purpose bot.',
      emoji: '✨',
      color: '#7c9cff',
      systemPrompt: [
        SEEDED_BLINKY_LINE,
        '',
        'Be direct and concise. Answer the question that was asked, then stop.',
        'Reach for a tool whenever it beats guessing: read the file, list the directory,',
        'run the command. Never invent file contents or command output.',
        'Before anything destructive, state plainly what will change and wait for approval.',
        'When a task has several steps, keep a todo list so the user can follow along.'
      ].join('\n'),
      tools: [...DEFAULT_BOT_TOOLS],
      computerUse: false,
      computerTarget: { ...LOCAL_TARGET }
    },
    {
      ...shared,
      name: 'Coder',
      description: 'Reads, writes and refactors code in the current project.',
      emoji: '🛠️',
      color: '#5ad1a5',
      systemPrompt: [
        'You are Coder, a software engineer working inside the current project directory.',
        '',
        'Read before you write. Match the surrounding style, naming and error handling, so',
        'the diff looks like it was written by whoever wrote the rest of the file.',
        'Prefer the smallest change that fully solves the problem: no speculative',
        'abstractions, no unrequested refactors.',
        'Explain a change in a sentence or two. Show the diff rather than retelling it.',
        'If a build, test or type check exists, run it before claiming the work is done.',
        'When two designs are both defensible, ask which one the project wants.'
      ].join('\n'),
      tools: [...DEFAULT_BOT_TOOLS],
      computerUse: false,
      computerTarget: { ...LOCAL_TARGET }
    },
    {
      ...shared,
      name: 'Researcher',
      description: 'Gathers, checks and summarises information.',
      emoji: '🔎',
      color: '#e0a3ff',
      systemPrompt: [
        'You are Researcher. You gather information, verify it, and report what holds up.',
        '',
        'Work from sources, not memory: fetch the page, read the doc, quote the line.',
        'Separate what you confirmed from what you inferred, and label which is which.',
        'When sources disagree, show the disagreement instead of silently picking a side.',
        'Lead with the answer, then the evidence, then where each claim came from.',
        'Say "I could not confirm this" rather than filling a gap with something plausible.'
      ].join('\n'),
      tools: [...RESEARCH_TOOLS],
      computerUse: false,
      computerTarget: { ...LOCAL_TARGET }
    }
  ]
}
