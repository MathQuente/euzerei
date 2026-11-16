import nodemailer, { Transporter } from 'nodemailer'
import { EmailContent, renderEmail } from './email-template'

const DEFAULT_SMTP_HOST = 'smtp.gmail.com'
const DEFAULT_SMTP_PORT = 465
const SMTP_TIMEOUT_MS = 10_000

export class EmailService {
  private transporter: Transporter | null = null
  private fromAddress = ''

  private getTransporter() {
    if (this.transporter) return this.transporter

    const user = process.env.MAIL_USERNAME
    const pass = process.env.MAIL_PASSWORD
    if (!user || !pass) {
      throw new Error(
        'MAIL_USERNAME and MAIL_PASSWORD are required to send email.'
      )
    }

    const port = Number(process.env.MAIL_PORT) || DEFAULT_SMTP_PORT
    this.fromAddress = user
    this.transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || DEFAULT_SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user, pass },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS
    })
    return this.transporter
  }

  private async send(to: string, subject: string, content: EmailContent) {
    const transporter = this.getTransporter()
    await transporter.sendMail({
      from: {
        name: process.env.MAIL_FROM_NAME || 'EuZerei',
        address: this.fromAddress
      },
      to,
      subject,
      ...renderEmail(content)
    })
  }

  async sendPasswordResetEmail(to: string, resetUrl: string) {
    await this.send(to, 'Redefinir sua senha — EuZerei', {
      heading: 'Redefinir sua senha',
      intro: 'Recebemos um pedido para redefinir a senha da sua conta.',
      buttonLabel: 'Criar nova senha',
      url: resetUrl,
      footnote:
        'Se você não pediu isso, pode ignorar este email. O link expira em 1 hora.'
    })
  }

  async sendPasswordChangedEmail(
    to: string,
    resetUrl: string,
    hadPassword: boolean
  ) {
    await this.send(
      to,
      hadPassword
        ? 'Sua senha do EuZerei foi alterada'
        : 'Uma senha foi definida na sua conta do EuZerei',
      {
        heading: hadPassword ? 'Sua senha foi alterada' : 'Senha definida',
        intro: hadPassword
          ? 'A senha da sua conta foi alterada agora há pouco e os outros dispositivos foram desconectados.'
          : 'Uma senha foi definida na sua conta agora há pouco e os outros dispositivos foram desconectados.',
        buttonLabel: 'Redefinir senha',
        url: resetUrl,
        footnote:
          'Se foi você, não precisa fazer nada. Se não foi, redefina a senha agora.'
      }
    )
  }

  async sendEmailChangeConfirmationEmail(to: string, confirmUrl: string) {
    await this.send(to, 'Confirme seu novo email — EuZerei', {
      heading: 'Confirme seu novo email',
      intro:
        'Recebemos um pedido para usar este endereço no EuZerei. Para concluir a troca, confirme abaixo.',
      buttonLabel: 'Confirmar novo email',
      url: confirmUrl,
      footnote:
        'O link vale por 24 horas. Se não foi você, ignore este email: nada muda.'
    })
  }

  async sendEmailChangeRequestedNoticeEmail(
    to: string,
    newEmail: string,
    accountUrl: string
  ) {
    await this.send(to, 'Pediram para trocar o email da sua conta — EuZerei', {
      heading: 'Pedido para trocar o email',
      intro: `Alguém pediu para trocar o email da sua conta para ${newEmail}. O email só muda se o link enviado a esse endereço for confirmado.`,
      buttonLabel: 'Cancelar a troca',
      url: accountUrl,
      footnote:
        'Se não foi você, entre na sua conta, cancele a troca em Configurações > Conta e troque a sua senha.'
    })
  }

  async sendEmailChangedNoticeEmail(
    oldEmail: string,
    newEmail: string,
    contactUrl: string
  ) {
    await this.send(oldEmail, 'O email da sua conta mudou — EuZerei', {
      heading: 'O email da sua conta mudou',
      intro: `O email da sua conta passou de ${oldEmail} para ${newEmail}, e todos os dispositivos foram desconectados.`,
      buttonLabel: 'Falar com a gente',
      url: contactUrl,
      footnote:
        'Se foi você, não precisa fazer nada. Se não foi, fale com a gente agora.'
    })
  }

  async sendEmailVerificationEmail(to: string, verifyUrl: string) {
    await this.send(to, 'Confirme seu email — EuZerei', {
      heading: 'Confirme seu email',
      intro: 'Para confirmar que este email é seu, use o botão abaixo.',
      buttonLabel: 'Confirmar meu email',
      url: verifyUrl,
      footnote:
        'Se você não criou uma conta, pode ignorar este email. O link expira em 24 horas.'
    })
  }
}
