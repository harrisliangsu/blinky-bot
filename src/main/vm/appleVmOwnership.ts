/**
 * Who owns a VM, and how the supervisor proves it before touching one.
 *
 * The runtime is a per-user singleton shared with anything else on the machine,
 * so name mangling is not enough: every destructive call first re-reads the
 * container's immutable OpenBOT labels and refuses anything that does not carry
 * this data profile's marker.
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { boxesDir } from '../store/paths'
import { commandRunner } from './commandRunner'
import type { VmTarget } from './types'

export interface AppleContainerInfo {
  id?: string
  configuration?: {
    labels?: Record<string, string>
  }
  status?: {
    state?: string
    networks?: Array<{ ipv4Address?: string }>
  }
}

export function ownerMarker(): string {
  // A path-derived opaque marker keeps two OpenBOT data profiles from ever
  // claiming or garbage-collecting each other's VMs.
  return createHash('sha256').update(resolve(boxesDir())).digest('hex').slice(0, 24)
}

export function managedVmName(vmId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(vmId)) throw new Error('The managed VM id is malformed.')
  return `openbot-${vmId}`
}

export async function assertOwned(binary: string, target: VmTarget, signal?: AbortSignal): Promise<AppleContainerInfo> {
  if (target.managed !== 'apple-vm') throw new Error('BlinkyBot does not own this external VM.')
  const name = managedVmName(target.vmId)
  const inspected = await commandRunner(binary, ['inspect', name], { timeoutMs: 15_000, signal })
  const entries = parseContainerJson(inspected.stdout)
  const info = entries.find((entry) => entry.id === name)
  if (!info) throw new Error(`The Apple VM runtime did not return ${name} from inspect.`)
  const labels = info?.configuration?.labels
  if (
    labels?.['com.openbot.vm-id'] !== target.vmId ||
    labels?.['com.openbot.managed'] !== 'true' ||
    labels?.['com.openbot.owner'] !== ownerMarker()
  ) {
    throw new Error('The VM failed its BlinkyBot ownership-label check.')
  }
  return info
}

export function parseContainerJson(output: string): AppleContainerInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(`The Apple VM runtime returned malformed JSON: ${output.trim() || '(empty)'}`)
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.filter((entry): entry is AppleContainerInfo => typeof entry === 'object' && entry !== null)
}

export function vmIp(info: AppleContainerInfo): string {
  const address = info.status?.networks?.find((network) => network.ipv4Address)?.ipv4Address
  const ip = address?.split('/')[0]
  if (!ip || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error('The Apple VM runtime did not report the VM private address.')
  }
  return ip
}
