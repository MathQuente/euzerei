import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { CloudinaryService, signUpload } from './cloudinary.service'

describe('CloudinaryService', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'mycloud')
    vi.stubEnv('CLOUDINARY_API_KEY', 'key')
    vi.stubEnv('CLOUDINARY_API_SECRET', 'secret')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('publicIdFromUrl', () => {
    it.each([
      [
        'https://res.cloudinary.com/mycloud/image/upload/v1700000000/images/abc123.jpg',
        'images/abc123'
      ],
      [
        'https://res.cloudinary.com/mycloud/image/upload/c_fill,w_200/v1700000000/images/sub/abc123.webp',
        'images/sub/abc123'
      ]
    ])('extracts the public id from %s', (url, expected) => {
      expect(CloudinaryService.publicIdFromUrl(url)).toBe(expected)
    })

    it.each([
      ['another cloud', 'https://res.cloudinary.com/other/image/upload/a.png'],
      ['another host', 'https://lh3.googleusercontent.com/a/abc'],
      ['plain http', 'http://res.cloudinary.com/mycloud/image/upload/a.png'],
      [
        'a video resource',
        'https://res.cloudinary.com/mycloud/video/upload/a.mp4'
      ],
      ['no public id', 'https://res.cloudinary.com/mycloud/image/upload/v123/'],
      [
        'no version segment',
        'https://res.cloudinary.com/mycloud/image/upload/c_fill,w_200/abc123.png'
      ],
      [
        'a malformed percent escape',
        'https://res.cloudinary.com/mycloud/image/upload/v1/images/%E0%A4%A.png'
      ],
      ['garbage', 'not a url']
    ])('returns null for %s', (_label, url) => {
      expect(CloudinaryService.publicIdFromUrl(url)).toBeNull()
    })

    it('returns null when the cloud name is not configured', () => {
      vi.stubEnv('CLOUDINARY_CLOUD_NAME', '')
      expect(
        CloudinaryService.publicIdFromUrl(
          'https://res.cloudinary.com/mycloud/image/upload/a.png'
        )
      ).toBeNull()
    })
  })

  describe('isConfigured', () => {
    it('is false when any credential is missing', () => {
      vi.stubEnv('CLOUDINARY_API_SECRET', '')
      expect(CloudinaryService.isConfigured()).toBe(false)
    })
  })

  describe('signUpload', () => {
    it('matches the Cloudinary documentation examples', () => {
      expect(signUpload({ timestamp: 1315060510 }, 'abcd')).toBe(
        'a21ad0f63beb4de2e5575204b79ab90bffb02c10'
      )
      expect(
        signUpload(
          {
            timestamp: 1315060510,
            public_id: 'sample_image',
            eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop'
          },
          'abcd'
        )
      ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e')
    })
  })

  describe('createUploadSignature', () => {
    beforeEach(() => {
      vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', 'signed_preset')
      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('signs the fixed folder, formats, preset, timestamp and a server id', () => {
      const result = CloudinaryService.createUploadSignature()

      expect(result).toEqual({
        cloudName: 'mycloud',
        apiKey: 'key',
        timestamp: 1_700_000_000,
        folder: 'images',
        publicId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        allowedFormats: 'jpg,png,webp,gif',
        uploadPreset: 'signed_preset',
        signature: createHash('sha1')
          .update(
            `allowed_formats=jpg,png,webp,gif&folder=images&public_id=${result.publicId}&timestamp=1700000000&upload_preset=signed_presetsecret`
          )
          .digest('hex')
      })
      expect(JSON.stringify(result)).not.toContain('secret')
    })

    it.each([
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
      'CLOUDINARY_UPLOAD_PRESET'
    ])('answers 503 when %s is missing', name => {
      vi.stubEnv(name, '')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() => CloudinaryService.createUploadSignature()).toThrow(
        expect.objectContaining({ statusCode: 503 })
      )
    })

    it('gives each signature its own id', () => {
      const first = CloudinaryService.createUploadSignature()
      const second = CloudinaryService.createUploadSignature()
      expect(first.publicId).not.toBe(second.publicId)
      expect(first.signature).not.toBe(second.signature)
    })

    it('keeps isConfigured independent of the preset', () => {
      vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', '')
      expect(CloudinaryService.isConfigured()).toBe(true)
    })
  })

  describe('destroy', () => {
    it('posts a signed destroy request', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ result: 'ok' }) })
      vi.stubGlobal('fetch', fetchMock)

      await CloudinaryService.destroy('folder/abc')

      const [url, init] = fetchMock.mock.calls[0]
      const body = init.body as URLSearchParams
      const expectedSignature = createHash('sha1')
        .update(
          'invalidate=true&public_id=folder/abc&timestamp=1700000000secret'
        )
        .digest('hex')
      expect(url).toBe('https://api.cloudinary.com/v1_1/mycloud/image/destroy')
      expect(init.method).toBe('POST')
      expect(body.get('public_id')).toBe('folder/abc')
      expect(body.get('api_key')).toBe('key')
      expect(body.get('signature')).toBe(expectedSignature)
      vi.restoreAllMocks()
    })

    it('throws when Cloudinary answers with an error status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 401 })
      )

      await expect(CloudinaryService.destroy('abc')).rejects.toThrow('401')
    })

    it('throws when Cloudinary does not report the asset as destroyed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ result: 'not found' })
        })
      )

      await expect(CloudinaryService.destroy('abc')).rejects.toThrow(
        'not found'
      )
    })

    it('makes no request without credentials', async () => {
      vi.stubEnv('CLOUDINARY_API_KEY', '')
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      await CloudinaryService.destroy('abc')

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
