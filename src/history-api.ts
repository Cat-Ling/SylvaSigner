import type { InstallMetadata, LitterboxExpiry, TemporaryInstallResult } from '@/install-api'

export type IpaHistoryEntry = {
  id: string
  name: string
  signedAt: string
  metadata?: Partial<InstallMetadata>
  provider?: 'litterbox'
  uploadExpiry?: LitterboxExpiry
  uploadedAt?: string
  expiresAt?: string
  ipaUrl?: string
  manifestUrl?: string
  installUrl?: string
}

const historyKey = 'sylva-signer-ipa-history'
const maxHistoryEntries = 30

export function readIpaHistory(): IpaHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey)
    if (!raw) return []
    const entries = JSON.parse(raw) as IpaHistoryEntry[]
    if (!Array.isArray(entries)) return []
    return entries
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
      .slice(0, maxHistoryEntries)
  } catch {
    return []
  }
}

export function writeIpaHistory(entries: IpaHistoryEntry[]) {
  localStorage.setItem(historyKey, JSON.stringify(entries.slice(0, maxHistoryEntries)))
}

export function createLocalHistoryEntry(
  name: string,
  metadata: Partial<InstallMetadata>,
): IpaHistoryEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name,
    signedAt: new Date().toISOString(),
    metadata,
  }
}

export function upsertIpaHistoryEntry(entry: IpaHistoryEntry) {
  const entries = readIpaHistory()
  const nextEntries = [entry, ...entries.filter((item) => item.id !== entry.id)]
  writeIpaHistory(nextEntries)
  return nextEntries
}

function expiryToMilliseconds(expiry: LitterboxExpiry) {
  if (expiry === '1h') return 60 * 60 * 1000
  if (expiry === '12h') return 12 * 60 * 60 * 1000
  if (expiry === '24h') return 24 * 60 * 60 * 1000
  return 72 * 60 * 60 * 1000
}

export function updateHistoryEntryUpload(
  id: string,
  result: TemporaryInstallResult,
  expiry: LitterboxExpiry,
) {
  const entries = readIpaHistory()
  const uploadedAt = Date.now()
  const nextEntries = entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          provider: 'litterbox' as const,
          uploadExpiry: expiry,
          uploadedAt: new Date(uploadedAt).toISOString(),
          expiresAt: new Date(uploadedAt + expiryToMilliseconds(expiry)).toISOString(),
          ipaUrl: result.ipaUrl,
          manifestUrl: result.manifestUrl,
          installUrl: result.installUrl,
        }
      : entry,
  )
  writeIpaHistory(nextEntries)
  return nextEntries
}

export function clearIpaHistory() {
  localStorage.removeItem(historyKey)
}
