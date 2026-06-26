export type NexCertEntry = {
  id: string
  company: string
  type: string
  status: string
  validFrom: string
  validTo: string
  downloadUrl: string
  sourceTreeUrl: string
  repository: string
  directoryPath: string
}

export type NexCertFiles = {
  p12: File
  profile: File
  password: string
}

type GithubContentItem = {
  name: string
  type: string
  download_url: string | null
}

const nexCertsReadmeUrl = 'https://raw.githubusercontent.com/NovaDev404/NexCerts/main/README.md'
const githubContentsRepos = ['NovaDev404/certificates', 'NovaDev404/NexCerts']

function decodeRepeated(value: string) {
  let current = value
  for (let index = 0; index < 4; index += 1) {
    try {
      const decoded = decodeURIComponent(current)
      if (decoded === current) break
      current = decoded
    } catch {
      break
    }
  }
  return current
}

function encodeGithubPath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function plainText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseDownloadLink(markdown: string) {
  const match = markdown.match(/\[Download\]\(([^)]+)\)/i)
  if (!match) return null

  const downloadUrl = match[1].trim()
  let sourceTreeUrl = ''
  let repository = ''
  let directoryPath = ''

  try {
    const download = new URL(downloadUrl)
    const rawTreeUrl = download.searchParams.get('url')
    if (!rawTreeUrl) return null

    const decodedTreeUrl = decodeRepeated(rawTreeUrl)
    const treeUrl = new URL(decodedTreeUrl)
    sourceTreeUrl = treeUrl.href
    const treeMatch = treeUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/)
    if (!treeMatch) return null

    repository = `${treeMatch[1]}/${treeMatch[2]}`
    directoryPath = decodeRepeated(treeMatch[4])
  } catch {
    return null
  }

  return { downloadUrl, sourceTreeUrl, repository, directoryPath }
}

export function parseNexCertsReadme(markdown: string): NexCertEntry[] {
  const entries: NexCertEntry[] = []
  const rowPattern =
    /\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\[Download\]\([^)]+\))\s*\|/gi

  for (const match of markdown.matchAll(rowPattern)) {
    const [, companyRaw, typeRaw, statusRaw, validFromRaw, validToRaw, downloadRaw] = match
    const company = plainText(companyRaw)
    const type = plainText(typeRaw)
    const status = plainText(statusRaw)
    const validFrom = plainText(validFromRaw)
    const validTo = plainText(validToRaw)
    const download = parseDownloadLink(downloadRaw)

    if (!download) continue
    if (!/enterprise certificate/i.test(type)) continue
    if (!status.includes('✅') || !/\bsigned\b/i.test(status)) continue

    entries.push({
      id: `${normalizeId(company)}-${normalizeId(validTo)}`,
      company,
      type,
      status: 'Signed',
      validFrom,
      validTo,
      ...download,
    })
  }

  return entries
}

export async function fetchSignedNexCerts(signal?: AbortSignal) {
  const response = await fetch(nexCertsReadmeUrl, { signal })
  if (!response.ok) throw new Error(`Could not load NexCerts README (${response.status}).`)
  return parseNexCertsReadme(await response.text())
}

async function fetchContents(repository: string, directoryPath: string, signal?: AbortSignal) {
  const candidates = Array.from(
    new Set([repository, ...githubContentsRepos].filter(Boolean)),
  )

  for (const candidate of candidates) {
    const url = `https://api.github.com/repos/${candidate}/contents/${encodeGithubPath(directoryPath)}?ref=main`
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    })

    if (response.ok) {
      const items = (await response.json()) as GithubContentItem[]
      if (Array.isArray(items)) return items
    }
  }

  throw new Error('Could not load the selected NexCerts certificate directory.')
}

async function downloadFile(url: string, name: string, type: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Could not download ${name} (${response.status}).`)
  return new File([await response.blob()], name, { type, lastModified: Date.now() })
}

export async function fetchNexCertFiles(entry: NexCertEntry, signal?: AbortSignal): Promise<NexCertFiles> {
  const contents = await fetchContents(entry.repository, entry.directoryPath, signal)
  const files = contents.filter((item) => item.type === 'file' && item.download_url)
  const p12Item = files.find((item) => /\.p12$/i.test(item.name))
  const profileItem = files.find((item) => /\.(mobileprovision|provisionprofile)$/i.test(item.name))
  const passwordItem = files.find((item) => /^password\.txt$/i.test(item.name))

  if (!p12Item?.download_url || !profileItem?.download_url || !passwordItem?.download_url) {
    throw new Error('The selected NexCerts directory is missing a P12, profile, or password.txt file.')
  }

  const [p12, profile, passwordResponse] = await Promise.all([
    downloadFile(p12Item.download_url, p12Item.name, 'application/x-pkcs12', signal),
    downloadFile(profileItem.download_url, profileItem.name, 'application/octet-stream', signal),
    fetch(passwordItem.download_url, { signal }),
  ])

  if (!passwordResponse.ok) {
    throw new Error(`Could not download ${passwordItem.name} (${passwordResponse.status}).`)
  }

  return {
    p12,
    profile,
    password: (await passwordResponse.text()).trim(),
  }
}
