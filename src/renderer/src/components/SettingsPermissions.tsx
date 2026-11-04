import { useState, type ReactNode } from 'react'
import type { ApprovalPolicy, Settings } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { editSettingsList, updateSettings } from '../state'
import { StringListEditor } from './StringListEditor'
import './SettingsPermissions.css'

interface SettingsPermissionsProps {
  settings: Settings
}

const POLICY_IDS: ApprovalPolicy[] = ['ask-every-time', 'ask-first-time', 'allowlist', 'auto-run']

/**
 * Where a bot may run the short side call that extracts memories from a turn.
 *
 * On a direct model API that is one cheap completion. On an agent CLI the same
 * call spawns a whole second agent process after EVERY turn — billable, running
 * its own tool loop — which is not something to do behind someone's back, so it
 * is off for CLIs unless asked for.
 */
/** Approval policy, command lists, and computer-use apps. */
export function SettingsPermissions({ settings }: SettingsPermissionsProps): ReactNode {
  const copy = useSettingsCopy().permissions
  const policyLabel: Record<ApprovalPolicy, { label: string; hint: string }> = {
    'ask-every-time': { label: copy.askEvery, hint: copy.askEveryHint },
    'ask-first-time': { label: copy.askOnce, hint: copy.askOnceHint },
    allowlist: { label: copy.allowlist, hint: copy.allowlistHint },
    'auto-run': { label: copy.auto, hint: copy.autoHint }
  }
  const policy = policyLabel[settings.approvalPolicy]
  /*
   * The rules box is typed into a draft and written on blur.
   *
   * Bound straight to `updateSettings`, every keystroke sent the whole prompt
   * over IPC and `updateSettings` serialises those writes, so a paragraph of
   * house rules was a disk write per character and a textarea that lagged the
   * keyboard. null means "no draft", so a value saved elsewhere shows through.
   */
  const [rulesDraft, setRulesDraft] = useState<string | null>(null)

  const commitRules = (): void => {
    if (rulesDraft !== null && rulesDraft !== settings.rules) void updateSettings({ rules: rulesDraft })
    setRulesDraft(null)
  }

  return (
    <section className="ob-settings-section">
      <div className="ob-field">
        <label htmlFor="ob-policy" className="ob-label">
          {copy.policy}
        </label>
        <select
          id="ob-policy"
          className="ob-select"
          value={settings.approvalPolicy}
          onChange={(e) => void updateSettings({ approvalPolicy: e.target.value as ApprovalPolicy })}
        >
          {POLICY_IDS.map((id) => (
            <option key={id} value={id}>
              {policyLabel[id].label}
            </option>
          ))}
        </select>
        <p className="ob-hint">{policy?.hint}</p>
      </div>

      {/*
        There was a "Sandbox" checkbox here promising to "confine file writes
        and commands to the working folder". Nothing read it, and there is no
        seatbelt anywhere — the confinement it described is done unconditionally
        by the path layer. A security control that does nothing is worse than
        none, because it invites trust it cannot repay, so it is gone rather
        than left switched on.
      */}
      {settings.approvalPolicy === 'auto-run' ? (
        <p className="ob-notice ob-notice-error" role="status">
          {copy.autoWarn}
        </p>
      ) : null}

      {/*
        One entry at a time — `editSettingsList` re-reads the file first. These
        two lists are shared with the agent: answering an approval with "always
        approve" appends a rule here, and this panel would not hear about it, so
        posting the whole array back would have wiped it.
      */}
      <StringListEditor
        label={copy.allow}
        hint={copy.allowHint}
        items={settings.allowlist}
        placeholder="Command or prefix"
        onEdit={(edit) => void editSettingsList('allowlist', edit)}
      />

      <StringListEditor
        label={copy.deny}
        hint={copy.denyHint}
        items={settings.denylist}
        placeholder="Command or prefix"
        tone="danger"
        onEdit={(edit) => void editSettingsList('denylist', edit)}
      />

      <div className="ob-field">
        <label htmlFor="ob-rules" className="ob-label">
          {copy.rules}
        </label>
        <p className="ob-hint">{copy.rulesHint}</p>
        <textarea
          id="ob-rules"
          className="ob-textarea"
          rows={6}
          value={rulesDraft ?? settings.rules}
          placeholder={copy.rulesPlaceholder}
          onChange={(e) => setRulesDraft(e.target.value)}
          onBlur={commitRules}
        />
      </div>

      <StringListEditor
        label={copy.computer}
        hint={copy.computerHint}
        items={settings.computerUseAllowedApps}
        placeholder="App name, e.g. Safari"
        onEdit={(edit) => void editSettingsList('computerUseAllowedApps', edit)}
      />

      {settings.computerUseAllowedApps.length === 0 ? (
        <p className="ob-notice" role="status">
          {copy.computerEmpty}
        </p>
      ) : null}
    </section>
  )
}
