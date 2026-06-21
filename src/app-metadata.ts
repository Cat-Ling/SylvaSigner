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
  const fileName = relative.toLowerCase()
  const normalized = normalizedIconName(relative)
  const declared = declaredNames.some((name) => normalized === normalizedIconName(name))
  const likelyIcon = /(?:^|[-_])(?:app)?icon/i.test(relative) || fileName === 'itunesartwork'
  if (!declared && !likelyIcon) return -1

  let score = declared ? 100 : 20
  if (!relative.includes('/')) score += 40
  if (fileName === 'itunesartwork') score += 80
  if (/1024/.test(fileName)) score += 60
  if (/@3x/.test(fileName)) score += 30
  else if (/@2x/.test(fileName)) score += 20
  if (/60x60|76x76|83\.5x83\.5/.test(fileName)) score += 10
  return score
}

function paethPredictor(left: number, above: number, upperLeft: number) {
  const prediction = left + above - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const aboveDistance = Math.abs(prediction - above)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

function concatBytes(chunks: Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

async function decodeCgbi(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, index) => bytes[index] === value)) return null

  let offset = 8
  let isCgbi = false
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatChunks: Uint8Array[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('The app icon PNG is truncated.')
    if (type === 'CgBI') isCgbi = true
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
    }
    if (type === 'IDAT') idatChunks.push(bytes.slice(dataStart, dataEnd))
    offset = dataEnd + 4
    if (type === 'IEND') break
  }
  if (!isCgbi) return null
  if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error('This Apple-optimized icon format is not supported.')
  }

  const compressed = concatBytes(idatChunks)
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat))
  const filtered = new Uint8Array(await new Response(stream).arrayBuffer())
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const expectedLength = height * (stride + 1)
  if (filtered.length < expectedLength) throw new Error('The Apple-optimized icon data is incomplete.')

  const pixels = new Uint8ClampedArray(width * height * 4)
  let inputOffset = 0
  const previous = new Uint8Array(stride)
  const current = new Uint8Array(stride)
  for (let row = 0; row < height; row++) {
    const filter = filtered[inputOffset++]
    for (let index = 0; index < stride; index++) {
      const raw = filtered[inputOffset++]
      const left = index >= channels ? current[index - channels] : 0
      const above = previous[index]
      const upperLeft = index >= channels ? previous[index - channels] : 0
      const value = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paethPredictor(left, above, upperLeft)
                : Number.NaN
      if (Number.isNaN(value)) throw new Error(`Unsupported PNG filter ${filter}.`)
      current[index] = value & 0xff
    }

    for (let column = 0; column < width; column++) {
      const source = column * channels
      const target = (row * width + column) * 4
      const alpha = channels === 4 ? current[source + 3] : 255
      const unpremultiply = (value: number) =>
        alpha > 0 && alpha < 255 ? Math.min(255, Math.round((value * 255) / alpha)) : value
      pixels[target] = unpremultiply(current[source + 2])
      pixels[target + 1] = unpremultiply(current[source + 1])
      pixels[target + 2] = unpremultiply(current[source])
      pixels[target + 3] = alpha
    }
    previous.set(current)
  }
  return { width, height, pixels }
}

async function iconDataUrl(bytes: Uint8Array): Promise<string | undefined> {
  const cgbi = await decodeCgbi(bytes)
  if (cgbi) {
    const source = document.createElement('canvas')
    source.width = cgbi.width
    source.height = cgbi.height
    const sourceContext = source.getContext('2d')
    if (!sourceContext) return undefined
    sourceContext.putImageData(new ImageData(cgbi.pixels, cgbi.width, cgbi.height), 0, 0)
    const thumbnail = document.createElement('canvas')
    thumbnail.width = 96
    thumbnail.height = 96
    thumbnail.getContext('2d')?.drawImage(source, 0, 0, 96, 96)
    return thumbnail.toDataURL('image/webp', 0.86)
  }

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
    return undefined
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
      iconDataUrl: iconBytes
        ? await iconDataUrl(iconBytes).catch(() => undefined)
        : undefined,
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
