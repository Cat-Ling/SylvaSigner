import type { OutputFile } from '@/types'

export type InstallMetadata = {
  appName: string
  bundleId: string
  version: string
}

export type LitterboxExpiry = '1h' | '12h' | '24h' | '72h'

export type TemporaryInstallResult = {
  ipaUrl: string
  manifestUrl: string
  installUrl: string
}

export type UploadProgressHandler = (percent: number) => void

const litterboxEndpoint = 'https://litterbox.catbox.moe/resources/internals/api.php'
const litterboxHost = 'https://litter.catbox.moe/'
const paleraManifestEndpoint = 'https://api.palera.in/genPlist'

export async function uploadSignedIpaToLitterbox(
  output: OutputFile,
  expiry: LitterboxExpiry = '1h',
  onProgress?: UploadProgressHandler,
) {
  const blob = new Blob([output.data], {
    type: output.type || 'application/octet-stream',
  })
  const fileName = output.name.toLowerCase().endsWith('.ipa')
    ? output.name
    : `${output.name}.ipa`

  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('time', expiry)
  form.append('fileToUpload', new File([blob], fileName, { type: blob.type }))

  const text = await new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', litterboxEndpoint)
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress?.(Math.min(95, Math.round((event.loaded / event.total) * 95)))
    }
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`Litterbox upload failed with HTTP ${request.status}.`))
        return
      }
      onProgress?.(100)
      resolve(request.responseText.trim())
    }
    request.onerror = () => reject(new Error('Litterbox upload failed.'))
    request.ontimeout = () => reject(new Error('Litterbox upload timed out.'))
    request.timeout = 30 * 60 * 1000
    request.send(form)
  })

  if (!text.startsWith(litterboxHost)) {
    throw new Error(text || 'Litterbox did not return a temporary file URL.')
  }

  return text
}

export function buildPaleraInstallUrls(
  metadata: InstallMetadata,
  ipaUrl: string,
): TemporaryInstallResult {
  const manifest = new URL(paleraManifestEndpoint)
  manifest.searchParams.set('bundleid', metadata.bundleId)
  manifest.searchParams.set('name', metadata.appName)
  manifest.searchParams.set('version', metadata.version)
  manifest.searchParams.set('fetchurl', ipaUrl)

  const manifestUrl = manifest.toString()

  return {
    ipaUrl,
    manifestUrl,
    installUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(
      manifestUrl,
    )}`,
  }
}
