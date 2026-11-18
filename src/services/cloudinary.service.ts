import { createHash, randomUUID } from 'crypto'
import { fetchWithTimeout } from '../utils/fetch-with-timeout'
import { ClientError } from '../errors/client-error'

const CLOUDINARY_HOST = 'res.cloudinary.com'
const DESTROY_TIMEOUT_MS = 5_000
const PUBLIC_ID_PREFIX = 'images/'
const VERSION_SEGMENT = /^v\d+$/
const UPLOAD_FOLDER = 'images'
const UPLOAD_ALLOWED_FORMATS = 'jpg,png,webp,gif'

export type UploadSignature = {
  cloudName: string
  apiKey: string
  timestamp: number
  folder: string
  publicId: string
  allowedFormats: string
  uploadPreset: string
  signature: string
}

export function signUpload(
  params: Record<string, string | number>,
  apiSecret: string
): string {
  const toSign = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
  return createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex')
}

export class CloudinaryService {
  static isConfigured(): boolean {
    return Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    )
  }

  static createUploadSignature(): UploadSignature {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET
    if (!cloudName || !apiKey || !apiSecret || !uploadPreset) {
      console.error('[Cloudinary] upload signing is not configured')
      throw new ClientError('Envio de imagens indisponível no momento.', 503)
    }

    // The id is signed, so one signature authorizes one asset: replaying it
    // targets the same id (the preset has overwrite off) instead of creating
    // a new asset each time.
    const publicId = randomUUID()
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = signUpload(
      {
        allowed_formats: UPLOAD_ALLOWED_FORMATS,
        folder: UPLOAD_FOLDER,
        public_id: publicId,
        timestamp,
        upload_preset: uploadPreset
      },
      apiSecret
    )

    return {
      cloudName,
      apiKey,
      timestamp,
      folder: UPLOAD_FOLDER,
      publicId,
      allowedFormats: UPLOAD_ALLOWED_FORMATS,
      uploadPreset,
      signature
    }
  }

  static publicIdFromUrl(rawUrl: string): string | null {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    if (!cloudName) return null

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.hostname !== CLOUDINARY_HOST) {
      return null
    }

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== cloudName) return null
    if (segments[1] !== 'image' || segments[2] !== 'upload') return null

    const versionIndex = segments.findIndex(
      (segment, index) => index >= 3 && VERSION_SEGMENT.test(segment)
    )
    if (versionIndex < 0) return null
    const idSegments = segments.slice(versionIndex + 1)
    if (idSegments.length === 0) return null

    let decoded: string
    try {
      decoded = decodeURIComponent(idSegments.join('/'))
    } catch {
      return null
    }
    const withoutExtension = decoded.replace(/\.[A-Za-z0-9]+$/, '')
    return withoutExtension.startsWith(PUBLIC_ID_PREFIX)
      ? withoutExtension
      : null
  }

  static async destroy(publicId: string): Promise<void> {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET
    if (!cloudName || !apiKey || !apiSecret) return

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = signUpload(
      { invalidate: 'true', public_id: publicId, timestamp },
      apiSecret
    )

    const body = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      invalidate: 'true',
      api_key: apiKey,
      signature
    })

    const response = await fetchWithTimeout(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      { method: 'POST', body },
      DESTROY_TIMEOUT_MS
    )
    if (!response.ok) {
      throw new Error(
        `Cloudinary destroy failed with status ${response.status}`
      )
    }
    const result = (await response.json()) as { result?: string }
    if (result.result !== 'ok') {
      throw new Error(
        `Cloudinary destroy returned ${result.result ?? 'no result'}`
      )
    }
  }
}
