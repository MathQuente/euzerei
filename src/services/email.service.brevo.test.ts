import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn()
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) }
})

vi.mock('nodemailer', () => ({ default: { createTransport } }))

import { EmailService } from './email.service'

const fetchMock = vi.fn()

function brevoOk() {
  return new Response(JSON.stringify({ messageId: '<id@brevo>' }), {
    status: 201
  })
}

describe('EmailService through Brevo', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(brevoOk())
    vi.stubGlobal('fetch', fetchMock)
    sendMail.mockReset()
    createTransport.mockClear()
    vi.stubEnv('BREVO_API_KEY', 'xkeysib-secret')
    vi.stubEnv('MAIL_FROM', 'suporte@exemplo.test')
    vi.stubEnv('MAIL_FROM_NAME', '')
    vi.stubEnv('MAIL_USERNAME', '')
    vi.stubEnv('MAIL_PASSWORD', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts the email to the Brevo API over HTTPS and never opens SMTP', async () => {
    await new EmailService().sendPasswordResetEmail(
      'a@a.com',
      'https://x.test/reset?token=2'
    )

    expect(createTransport).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(init.method).toBe('POST')
    expect(init.headers['api-key']).toBe('xkeysib-secret')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const body = JSON.parse(init.body)
    expect(body.sender).toEqual({
      name: 'EuZerei',
      email: 'suporte@exemplo.test'
    })
    expect(body.to).toEqual([{ email: 'a@a.com' }])
    expect(body.subject).toBe('Redefinir sua senha — EuZerei')
    expect(body.htmlContent).toContain('https://x.test/reset?token=2')
    expect(body.textContent).toContain('https://x.test/reset?token=2')
  })

  it('uses the configured sender name', async () => {
    vi.stubEnv('MAIL_FROM_NAME', 'Suporte EuZerei')

    await new EmailService().sendEmailVerificationEmail(
      'a@a.com',
      'https://x.test/verify'
    )

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sender.name).toBe(
      'Suporte EuZerei'
    )
  })

  it('fails with a clear error and sends nothing when MAIL_FROM is missing', async () => {
    vi.stubEnv('MAIL_FROM', '')

    await expect(
      new EmailService().sendPasswordResetEmail('a@a.com', 'https://x.test')
    ).rejects.toThrow('MAIL_FROM is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a rejection into an error with the status and code, never the key', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Key not found' }),
        { status: 401 }
      )
    )

    const failure = await new EmailService()
      .sendPasswordResetEmail('a@a.com', 'https://x.test')
      .catch((error: Error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Brevo rejected the email (HTTP 401, unauthorized).'
    )
    expect((failure as Error).message).not.toContain('xkeysib-secret')
  })

  it('handles a rejection whose body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }))

    await expect(
      new EmailService().sendPasswordResetEmail('a@a.com', 'https://x.test')
    ).rejects.toThrow('Brevo rejected the email (HTTP 502).')
  })

  it('passes a network failure on to the caller', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    await expect(
      new EmailService().sendPasswordResetEmail('a@a.com', 'https://x.test')
    ).rejects.toThrow('network down')
  })

  it('keeps using SMTP when there is no Brevo key', async () => {
    vi.stubEnv('BREVO_API_KEY', '')
    vi.stubEnv('MAIL_USERNAME', 'euzerei.suporte@gmail.com')
    vi.stubEnv('MAIL_PASSWORD', 'app-password')
    sendMail.mockResolvedValue({})

    await new EmailService().sendPasswordResetEmail('a@a.com', 'https://x.test')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledTimes(1)
  })
})
