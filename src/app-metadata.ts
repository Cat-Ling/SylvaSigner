import { BlobReader, Uint8ArrayWriter, ZipReader, type Entry } from '@zip.js/zip.js'
import { parse as parseBinaryPlist } from '@plist/binary.parse'

export type AppMetadata = {
  appName: string
  bundleId: string
  version: string
  iconDataUrl?: string
}

export type CertificateMetadata = {
  name: string
  expiresAt: string
}

export type ProvisioningMetadata = {
  name: string
  expiresAt: string
}

type PlistRecord = Record<string, unknown>

function parseXmlNode(element: Element): unknown {
  if (element.tagName === 'dict') {
    const result: PlistRecord = {}
    const children = [...element.children]
    for (let index = 0; index < children.length; index += 2) {
      const key = children[index]
      const value = children[index + 1]
      if (key?.tagName === 'key' && value) result[key.textContent ?? ''] = parseXmlNode(value)
    }
    return result
  }
  if (element.tagName === 'array') return [...element.children].map(parseXmlNode)
  if (element.tagName === 'true') return true
  if (element.tagName === 'false') return false
  if (element.tagName === 'integer' || element.tagName === 'real') return Number(element.textContent)
  if (element.tagName === 'date') return new Date(element.textContent ?? '')
  return element.textContent ?? ''
}

function parsePlist(input: ArrayBuffer | string) {
  if (input instanceof ArrayBuffer) {
    const header = new TextDecoder().decode(input.slice(0, 8))
    if (header === 'bplist00') return parseBinaryPlist(input)
    input = new TextDecoder().decode(input)
  }
  const document = new DOMParser().parseFromString(input, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('The property list XML is malformed.')
  const root = document.documentElement.tagName === 'plist'
    ? document.documentElement.firstElementChild
    : document.documentElement
  if (!root) throw new Error('The property list is empty.')
  return parseXmlNode(root)
}

function asRecord(value: unknown): PlistRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlistRecord)
    : {}
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function arrayStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function exactArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function iconNames(info: PlistRecord) {
  const names = new Set<string>()
  const addIcons = (iconsValue: unknown) => {
    const icons = asRecord(iconsValue)
    const primary = asRecord(icons.CFBundlePrimaryIcon)
    arrayStrings(primary.CFBundleIconFiles).forEach((name) => names.add(name))
    const iconName = asString(primary.CFBundleIconName)
    if (iconName) names.add(iconName)
  }

  arrayStrings(info.CFBundleIconFiles).forEach((name) => names.add(name))
  addIcons(info.CFBundleIcons)
  addIcons(info['CFBundleIcons~ipad'])
  return [...names]
}

function normalizedIconName(value: string) {
  return value
    .split('/').at(-1)!
    .replace(/\.png$/i, '')
    .replace(/@[23]x$/i, '')
    .replace(/~ipad$/i, '')
    .toLowerCase()
}

function iconScore(entry: Entry, declaredNames: string[], appRoot: string) {
  if (entry.directory || !entry.filename.startsWith(appRoot)) return -1
  const relative = entry.filename.slice(appRoot.length)
  if (relative.includes('/')) return -1
  const fileName = relative.toLowerCase()
  const normalized = normalizedIconName(relative)
  const declared = declaredNames.some((name) => normalized === normalizedIconName(name))
  const likelyIcon = /(?:^|[-_])(?:app)?icon/i.test(relative) || fileName === 'itunesartwork'
  if (!declared && !likelyIcon) return -1

  let score = declared ? 100 : 20
  if (fileName === 'itunesartwork') score += 80
  if (/1024/.test(fileName)) score += 60
  if (/@3x/.test(fileName)) score += 30
  else if (/@2x/.test(fileName)) score += 20
  if (/60x60|76x76|83\.5x83\.5/.test(fileName)) score += 10
  return score
}

async function iconDataUrl(bytes: Uint8Array) {
  const blob = new Blob([exactArrayBuffer(bytes)], { type: 'image/png' })
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable.')
    context.drawImage(bitmap, 0, 0, 96, 96)
    bitmap.close()
    return canvas.toDataURL('image/webp', 0.86)
  } catch {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }
}

export async function extractAppMetadata(ipa: Blob): Promise<AppMetadata> {
  const reader = new ZipReader(new BlobReader(ipa), {
    useCompressionStream: true,
    useWebWorkers: false,
  })
  try {
    const entries = await reader.getEntries()
    const infoEntry = entries.find((entry) =>
      /^Payload\/[^/]+\.app\/Info\.plist$/i.test(entry.filename),
    )
    if (!infoEntry || infoEntry.directory) throw new Error('The IPA does not contain an app Info.plist.')

    const appRoot = infoEntry.filename.slice(0, -'Info.plist'.length)
    const infoBytes = await infoEntry.getData(new Uint8ArrayWriter())
    const info = asRecord(parsePlist(exactArrayBuffer(infoBytes)))
    const appName =
      asString(info.CFBundleDisplayName) ||
      asString(info.CFBundleName) ||
      appRoot.match(/\/([^/]+)\.app\/$/)?.[1] ||
      'Unknown App'
    const bundleId = asString(info.CFBundleIdentifier)
    const version = asString(info.CFBundleShortVersionString) || asString(info.CFBundleVersion)
    if (!bundleId) throw new Error('The app Info.plist does not contain a bundle identifier.')

    const declaredNames = iconNames(info)
    const iconEntry = entries
      .map((entry) => ({ entry, score: iconScore(entry, declaredNames, appRoot) }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => right.score - left.score)[0]?.entry
    const iconBytes = iconEntry && !iconEntry.directory
      ? await iconEntry.getData(new Uint8ArrayWriter())
      : undefined

    return {
      appName,
      bundleId,
      version: version || 'Unknown',
      iconDataUrl: iconBytes ? await iconDataUrl(iconBytes) : undefined,
    }
  } finally {
    await reader.close()
  }
}

export async function extractCertificateMetadata(
  file: Blob,
  password: string,
): Promise<CertificateMetadata> {
  const forge = (await import('node-forge')).default
  const bytes = new Uint8Array(await file.arrayBuffer())
  const binary = forge.util.binary.raw.encode(bytes)
  const asn1 = forge.asn1.fromDer(binary)
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password)
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[
    forge.pki.oids.certBag
  ] ?? []
  const certificate = certBags.find((bag) => bag.cert)?.cert
  if (!certificate) throw new Error('No signing certificate was found in this P12/PFX file.')
  const commonName = certificate.subject.getField('CN')?.value
  return {
    name: typeof commonName === 'string' ? commonName : 'Signing Certificate',
    expiresAt: certificate.validity.notAfter.toISOString(),
  }
}

export async function extractProvisioningMetadata(file: Blob): Promise<ProvisioningMetadata> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const start = text.indexOf('<?xml')
  const end = text.indexOf('</plist>', start)
  if (start < 0 || end < 0) throw new Error('The provisioning profile plist could not be read.')
  const profile = asRecord(parsePlist(text.slice(start, end + '</plist>'.length)))
  const expiration = profile.ExpirationDate
  const expiresAt = expiration instanceof Date
    ? expiration.toISOString()
    : new Date(asString(expiration)).toISOString()
  const profileName = asString(profile.Name) || asString(profile.TeamName)
  return {
    name: profileName || (file instanceof File ? file.name : 'Provisioning Profile'),
    expiresAt,
  }
}
