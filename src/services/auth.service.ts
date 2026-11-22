import { JWT } from '@fastify/jwt'
import { AuthRepository } from '../repositories/auth.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { EmailService } from './email.service'
import { AccountSuspendedError } from '../errors/account-suspended-error'
import { ClientError } from '../errors/client-error'
import { ReauthRequiredError } from '../errors/reauth-required-error'
import { ProviderLinkError } from '../errors/provider-link-error'
import { TermsRequiredError } from '../errors/terms-required-error'
import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { CreateUserDTO } from '../dtos/user.dto'
import { generateFromEmail } from 'unique-username-generator'
import { hashToken } from '../utils/hash-token'
import { RecentAuthService } from './recent-auth.service'
import { markSessionsRevoked } from '../utils/session-revocation'
import { logError } from '../utils/respond-unavailable'
import { normalizeEmail } from '../utils/normalize-email'
import { isUniqueViolation } from '../utils/prisma-errors'
import {
  EMAIL_CHANGE_TTL_SECONDS,
  PendingEmailChange,
  emailChangeCurrentKey,
  emailChangeKey,
  parsePendingEmailChange
} from '../utils/email-change'

const BCRYPT_COST = 12

const PASSWORD_RESET_TTL_SECONDS = 60 * 60
const passwordResetKey = (token: string) => `password-reset:${hashToken(token)}`

const MAX_RESET_REQUESTS_PER_HOUR = 3
const RESET_REQUESTS_WINDOW_SECONDS = 60 * 60
const passwordResetRequestsKey = (email: string) =>
  `password-reset-requests:${hashToken(normalizeEmail(email))}`

const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60
const emailVerificationKey = (tokenHash: string) =>
  `email-verification:${tokenHash}`
const emailVerificationCurrentKey = (userId: string) =>
  `email-verification-current:${userId}`

const MAX_VERIFICATION_REQUESTS_PER_HOUR = 3
const VERIFICATION_REQUESTS_WINDOW_SECONDS = 60 * 60
const emailVerificationRequestsKey = (userId: string) =>
  `email-verification-requests:${userId}`

const SIGNUP_PENDING_TTL_SECONDS = 24 * 60 * 60
const signupPendingKey = (tokenHash: string) => `signup-pending:${tokenHash}`
const signupPendingCurrentKey = (email: string) =>
  `signup-pending-current:${hashToken(normalizeEmail(email))}`
const MAX_SIGNUP_REQUESTS_PER_HOUR = 3
const SIGNUP_REQUESTS_WINDOW_SECONDS = 60 * 60
const signupRequestsKey = (email: string) =>
  `signup-requests:${hashToken(normalizeEmail(email))}`

function randomToken() {
  return randomBytes(32).toString('hex')
}

const MAX_LOGIN_FAILURES_PER_IP = 10
const MAX_LOGIN_FAILURES_PER_EMAIL = 50
const LOGIN_FAILURES_WINDOW_SECONDS = 15 * 60
const loginFailuresByEmailKey = (email: string) =>
  `login-failures:${hashToken(normalizeEmail(email))}`
const loginFailuresByIpKey = (email: string, ip: string) =>
  `${loginFailuresByEmailKey(email)}:${hashToken(ip)}`
const FAMILIAR_IP_TTL_SECONDS = 30 * 24 * 60 * 60
const familiarIpKey = (email: string, ip: string) =>
  `login-familiar-ip:${hashToken(normalizeEmail(email))}:${hashToken(ip)}`
const PASSWORD_CHANGE_MAX_FAILURES = 5
const PASSWORD_CHANGE_WINDOW_SECONDS = 15 * 60
const passwordChangeFailuresKey = (userId: string) =>
  `password-change-failures:${userId}`
const EMAIL_CHANGE_MAX_REQUESTS_PER_HOUR = 5
const EMAIL_CHANGE_REQUESTS_WINDOW_SECONDS = 60 * 60
const emailChangeRequestsKey = (userId: string) =>
  `email-change-requests:${userId}`
const passwordResetEpochKey = (userId: string) =>
  `password-reset-epoch:${userId}`
export type OAuthProvider = 'google' | 'discord'
const PROVIDER_LABEL: Record<OAuthProvider, 'Google' | 'Discord'> = {
  google: 'Google',
  discord: 'Discord'
}
const EMAIL_TAKEN_MESSAGE = 'Este e-mail já está em uso.'
const INVALID_EMAIL_CHANGE_LINK_MESSAGE =
  'Link de confirmação inválido ou expirado.'
const assertNotSuspended = (user: { suspendedAt?: Date | null } | null) => {
  if (user?.suspendedAt) throw new AccountSuspendedError()
}
const hasReached = (failures: unknown, limit: number) =>
  typeof failures === 'number' && failures >= limit

export const revokedAccessTokenKey = (accessToken: string) =>
  `revoked:${hashToken(accessToken)}`

let dummyPasswordHash: Promise<string> | undefined
function getDummyPasswordHash() {
  dummyPasswordHash ??= bcrypt.hash(crypto.randomUUID(), BCRYPT_COST)
  return dummyPasswordHash
}

const PROVIDER_ALREADY_LINKED_MESSAGE =
  'Este email já está vinculado a outra conta desse provedor.'

const UNVERIFIED_PROVIDER_EMAIL_MESSAGE =
  'O email dessa conta não foi verificado pelo provedor.'

export class AuthService {
  constructor(
    private authRepository: AuthRepository,
    private jwt: JWT,
    private cacheRepository: CacheRepository,
    private emailService: EmailService = new EmailService(),
    private recentAuthService: RecentAuthService = new RecentAuthService(
      cacheRepository
    )
  ) {}

  private signTokens(userId: string) {
    const accessToken = this.jwt.sign(
      { userId, tokenType: 'access' },
      { expiresIn: '15m' }
    )

    const refreshToken = this.jwt.sign(
      { userId, tokenType: 'refresh', jti: crypto.randomUUID() },
      { expiresIn: '7d' }
    )

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    return { accessToken, refreshToken, expiresAt }
  }

  async generateTokens(userId: string) {
    const tokens = this.signTokens(userId)

    await this.authRepository.saveToken(
      tokens.refreshToken,
      userId,
      tokens.expiresAt
    )

    return tokens
  }

  async validateRefreshToken(refreshToken: string) {
    const storedToken = await this.authRepository.findToken(refreshToken)

    if (
      !storedToken ||
      !storedToken.isValid ||
      storedToken.expiresAt < new Date() ||
      storedToken.user?.suspendedAt
    ) {
      throw new ClientError('Sessão inválida ou expirada.', 401)
    }

    let userId: string
    try {
      const decoded = this.jwt.verify(refreshToken) as {
        userId: string
        tokenType?: string
      }
      if (decoded.tokenType === 'access' || decoded.tokenType === 'panel') {
        throw new ClientError('Sessão inválida.', 401)
      }
      userId = decoded.userId
    } catch (error) {
      if (error instanceof ClientError) {
        throw error
      }
      const { code, message } = error as { code?: string; message?: string }
      if (code === 'FAST_JWT_EXPIRED' || message?.includes('expired')) {
        throw new ClientError('Sessão expirada.', 401)
      }
      throw new ClientError('Sessão inválida.', 401)
    }

    return userId
  }

  async isRefreshTokenActive(refreshToken: string): Promise<string | null> {
    const storedToken = await this.authRepository.findToken(refreshToken)

    if (
      !storedToken ||
      !storedToken.isValid ||
      storedToken.expiresAt < new Date() ||
      storedToken.user?.suspendedAt
    ) {
      return null
    }

    try {
      const decoded = this.jwt.verify(refreshToken) as {
        userId: string
        tokenType?: string
      }
      return decoded.tokenType === 'access' || decoded.tokenType === 'panel'
        ? null
        : decoded.userId
    } catch {
      return null
    }
  }

  async refreshTokens(refreshToken: string) {
    const userId = await this.validateRefreshToken(refreshToken)

    const {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt
    } = this.signTokens(userId)

    await this.authRepository.rotateToken(
      refreshToken,
      newRefreshToken,
      userId,
      expiresAt
    )

    return { accessToken, refreshToken: newRefreshToken, expiresAt }
  }

  /**
   * Responde igual para e-mail novo e já cadastrado: quem consulta não
   * descobre se existe conta. A conta só nasce em confirmRegistration, com o
   * link enviado ao e-mail.
   */
  async createUser(data: CreateUserDTO) {
    const email = normalizeEmail(data.email)

    const existing = await this.authRepository.findByEmail(email)
    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST)

    const requests = await this.cacheRepository.increment(
      signupRequestsKey(email),
      SIGNUP_REQUESTS_WINDOW_SECONDS
    )
    if (requests > MAX_SIGNUP_REQUESTS_PER_HOUR) return

    if (existing) {
      this.deliverInBackground(() =>
        this.emailService.sendSignupAttemptNoticeEmail(
          email,
          `${process.env.FRONTEND_URL}/auth`,
          `${process.env.FRONTEND_URL}/forgot-password`
        )
      )
      return
    }

    const token = randomToken()
    const tokenHash = hashToken(token)

    const previousHash = await this.cacheRepository.get(
      signupPendingCurrentKey(email)
    )
    if (typeof previousHash === 'string') {
      await this.cacheRepository.del(signupPendingKey(previousHash))
    }
    await this.cacheRepository.set(
      signupPendingKey(tokenHash),
      { email, passwordHash },
      SIGNUP_PENDING_TTL_SECONDS
    )
    await this.cacheRepository.set(
      signupPendingCurrentKey(email),
      tokenHash,
      SIGNUP_PENDING_TTL_SECONDS
    )

    const confirmUrl = `${process.env.FRONTEND_URL}/confirmar-cadastro?token=${token}`
    if (process.env.NODE_ENV !== 'production') {
      console.info('[Signup] dev confirmation link:', confirmUrl)
    }
    this.deliverInBackground(() =>
      this.emailService.sendRegistrationConfirmationEmail(email, confirmUrl)
    )
  }

  async confirmRegistration(token: string) {
    const pending = (await this.cacheRepository.getdel(
      signupPendingKey(hashToken(token))
    )) as { email?: unknown; passwordHash?: unknown } | null

    const invalid = () =>
      new ClientError('Link de confirmação inválido ou expirado.', 400)

    if (
      !pending ||
      typeof pending.email !== 'string' ||
      typeof pending.passwordHash !== 'string'
    ) {
      throw invalid()
    }

    const email = pending.email
    await this.cacheRepository.del(signupPendingCurrentKey(email))

    if (await this.authRepository.findByEmail(email)) throw invalid()

    let user: { id: string }
    try {
      user = await this.authRepository.createUser({
        email,
        password: pending.passwordHash,
        userName: generateFromEmail(email, 4),
        emailVerifiedAt: new Date()
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw invalid()
      throw error
    }

    const { accessToken, refreshToken } = await this.generateTokens(user.id)
    await this.recentAuthService.mark(user.id)

    return { accessToken, refreshToken, user: { id: user.id } }
  }

  private deliverInBackground(send: () => Promise<void>) {
    void Promise.resolve()
      .then(send)
      .catch(err => {
        console.error('[Signup] email delivery failed', {
          error: err instanceof Error ? err.message : 'unknown error'
        })
      })
  }

  private async issueEmailVerification(userId: string, email: string) {
    const token = randomToken()
    const tokenHash = hashToken(token)

    await this.cacheRepository.set(
      emailVerificationKey(tokenHash),
      userId,
      EMAIL_VERIFICATION_TTL_SECONDS
    )

    const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`

    try {
      await this.emailService.sendEmailVerificationEmail(email, verifyUrl)
    } catch (err) {
      console.error('[EmailVerification] email delivery failed', {
        error: err instanceof Error ? err.message : 'unknown error'
      })
      if (process.env.NODE_ENV !== 'production') {
        console.info('[EmailVerification] dev verification link:', verifyUrl)
      }
      return false
    }

    const previousHash = await this.cacheRepository.get(
      emailVerificationCurrentKey(userId)
    )
    if (typeof previousHash === 'string') {
      await this.cacheRepository.del(emailVerificationKey(previousHash))
    }
    await this.cacheRepository.set(
      emailVerificationCurrentKey(userId),
      tokenHash,
      EMAIL_VERIFICATION_TTL_SECONDS
    )
    return true
  }

  async verifyEmail(token: string) {
    const userId = (await this.cacheRepository.getdel(
      emailVerificationKey(hashToken(token))
    )) as string | null

    if (!userId) {
      throw new ClientError('Link de verificação inválido ou expirado.', 400)
    }

    await this.authRepository.markEmailVerified(userId)
    await this.cacheRepository.del(emailVerificationCurrentKey(userId))
  }

  async resendEmailVerification(userId: string) {
    const user = await this.authRepository.findById(userId)
    if (!user) throw new ClientError('Usuário não encontrado.', 404)
    if (user.emailVerifiedAt) return

    await this.sendVerificationRequest(user)
  }

  /**
   * Pedido do admin: diferente do pedido do próprio usuário, diz o que aconteceu em vez de voltar em silêncio.
   * O limite por hora é o mesmo do usuário (um admin repetindo não contorna o limite de envios).
   */
  async resendEmailVerificationAsAdmin(userId: string) {
    const user = await this.authRepository.findById(userId)
    if (!user) throw new ClientError('Usuário não encontrado.', 404)
    if (user.emailVerifiedAt) {
      throw new ClientError('O e-mail desta conta já está verificado.', 409)
    }

    await this.sendVerificationRequest(user)
  }

  private async sendVerificationRequest(user: { id: string; email: string }) {
    const userId = user.id
    const requests = await this.cacheRepository.increment(
      emailVerificationRequestsKey(userId),
      VERIFICATION_REQUESTS_WINDOW_SECONDS
    )
    if (requests > MAX_VERIFICATION_REQUESTS_PER_HOUR) {
      throw new ClientError(
        'Muitos pedidos de verificação. Tente novamente mais tarde.',
        429
      )
    }

    const sent = await this.issueEmailVerification(user.id, user.email)
    if (!sent) {
      throw new ClientError('Não foi possível enviar o email agora.', 503)
    }
  }

  private randomPasswordHash() {
    return bcrypt.hash(crypto.randomUUID(), BCRYPT_COST)
  }

  async revokeAllSessions(userId: string) {
    await this.authRepository.deleteTokensByUserId(userId)
    await markSessionsRevoked(this.cacheRepository, userId)
    await this.cancelEmailChange(userId)
  }

  private async markRevokedAfterLink(userId: string) {
    try {
      await markSessionsRevoked(this.cacheRepository, userId)
      await this.cancelEmailChange(userId)
    } catch (error) {
      logError('Post-link session revocation failed:', error)
    }
  }

  async loginWithGoogle(
    profile: {
      sub: string
      email: string
      email_verified?: boolean
      name: string
      picture: string
    },
    acceptedTerms: boolean
  ) {
    let user = await this.authRepository.findUserByGoogleId(profile.sub)
    assertNotSuspended(user)

    if (!user) {
      if (!profile.email || profile.email_verified !== true) {
        throw new ClientError(UNVERIFIED_PROVIDER_EMAIL_MESSAGE, 403)
      }

      const email = normalizeEmail(profile.email)

      const existing = await this.authRepository.findByEmail(email)

      if (existing) {
        if (existing.googleId) {
          throw new ClientError(PROVIDER_ALREADY_LINKED_MESSAGE, 409)
        }
        assertNotSuspended(existing)

        const discardedPasswordHash =
          existing.discordId || existing.emailVerifiedAt
            ? null
            : await this.randomPasswordHash()

        if (discardedPasswordHash) {
          await markSessionsRevoked(this.cacheRepository, existing.id)
        }

        user = await this.authRepository.linkGoogle(
          existing.id,
          profile.sub,
          profile.picture,
          discardedPasswordHash
        )

        if (discardedPasswordHash) {
          await this.markRevokedAfterLink(existing.id)
        }
      } else {
        if (!acceptedTerms) throw new TermsRequiredError()

        const hashedPassword = await bcrypt.hash(randomToken(), BCRYPT_COST)

        const created = await this.authRepository.createUserWithGoogle({
          email,
          name: profile.name,
          picture: profile.picture,
          googleId: profile.sub,
          password: hashedPassword
        })

        user = {
          id: created.id,
          email,
          userName: created.userName ?? profile.name,
          profilePicture: profile.picture,
          suspendedAt: null
        }
      }
    }

    const { accessToken, refreshToken, expiresAt } = await this.generateTokens(
      user.id
    )
    await this.recentAuthService.mark(user.id)

    return { user, accessToken, refreshToken, expiresAt }
  }

  async loginWithDiscord(
    discordUser: {
      id: string
      email: string
      verified?: boolean
      username: string
      avatar: string | null
    },
    acceptedTerms: boolean
  ) {
    let user = await this.authRepository.findByDiscordId(discordUser.id)
    assertNotSuspended(user)

    const profilePicture = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null

    if (!user) {
      if (!discordUser.email || discordUser.verified !== true) {
        throw new ClientError(UNVERIFIED_PROVIDER_EMAIL_MESSAGE, 403)
      }

      const email = normalizeEmail(discordUser.email)

      const existing = await this.authRepository.findByEmail(email)

      if (existing) {
        if (existing.discordId) {
          throw new ClientError(PROVIDER_ALREADY_LINKED_MESSAGE, 409)
        }
        assertNotSuspended(existing)

        const existingId = existing.id
        const discardedPasswordHash =
          existing.googleId || existing.emailVerifiedAt
            ? null
            : await this.randomPasswordHash()

        if (discardedPasswordHash) {
          await markSessionsRevoked(this.cacheRepository, existingId)
        }

        user = await this.authRepository.linkDiscord(
          existingId,
          discordUser.id,
          profilePicture,
          discardedPasswordHash
        )

        if (discardedPasswordHash) {
          await this.markRevokedAfterLink(existingId)
        }
      } else {
        if (!acceptedTerms) throw new TermsRequiredError()

        const hashedPassword = await bcrypt.hash(
          crypto.randomUUID(),
          BCRYPT_COST
        )
        user = await this.authRepository.createWithDiscord({
          email,
          userName: `${discordUser.username}`,
          discordId: discordUser.id,
          password: hashedPassword,
          profilePicture
        })
      }
    }

    const tokens = await this.generateTokens(user.id)
    await this.recentAuthService.mark(user.id)
    return tokens
  }

  async validateUser(email: string, password: string, ip: string) {
    const ipFailuresKey = loginFailuresByIpKey(email, ip)
    const emailFailuresKey = loginFailuresByEmailKey(email)
    const familiarKey = familiarIpKey(email, ip)
    const [ipFailures, emailFailures, familiar] = await Promise.all([
      this.cacheRepository.get(ipFailuresKey),
      this.cacheRepository.get(emailFailuresKey),
      this.cacheRepository.get(familiarKey)
    ])
    const isFamiliarIp = familiar !== null
    if (
      hasReached(ipFailures, MAX_LOGIN_FAILURES_PER_IP) ||
      (!isFamiliarIp && hasReached(emailFailures, MAX_LOGIN_FAILURES_PER_EMAIL))
    ) {
      throw new ClientError(
        'Muitas tentativas de login. Tente novamente mais tarde.',
        429
      )
    }

    const user = await this.authRepository.findByEmail(email, true)

    const infoIsMatch = await bcrypt.compare(
      password,
      user?.password ?? (await getDummyPasswordHash())
    )

    if (!user || !infoIsMatch) {
      const ipCount = await this.cacheRepository.increment(
        ipFailuresKey,
        LOGIN_FAILURES_WINDOW_SECONDS
      )
      if (ipCount === MAX_LOGIN_FAILURES_PER_IP) {
        console.warn('[Login] blocked', { scope: 'ip' })
      }
      if (!isFamiliarIp) {
        const emailCount = await this.cacheRepository.increment(
          emailFailuresKey,
          LOGIN_FAILURES_WINDOW_SECONDS
        )
        if (emailCount === MAX_LOGIN_FAILURES_PER_EMAIL) {
          console.warn('[Login] blocked', { scope: 'email' })
        }
      }
      throw new ClientError('Email ou senha incorretos.')
    }

    assertNotSuspended(user)

    await this.cacheRepository.del(ipFailuresKey)
    await this.cacheRepository.set(familiarKey, true, FAMILIAR_IP_TTL_SECONDS)
    await this.recentAuthService.mark(user.id)

    return {
      user: {
        id: user.id,
        userName: user.userName
      }
    }
  }

  /**
   * Pedido do admin: o link vai para o e-mail da conta (o admin nunca vê o token), o envio é aguardado e o resultado
   * volta como erro explícito (429 limite, 503 falha do SMTP) em vez de ser engolido como no pedido público.
   */
  async requestPasswordResetAsAdmin(userId: string) {
    const user = await this.authRepository.findProviderState(userId)
    if (!user) throw new ClientError('Usuário não encontrado.', 404)

    const requests = await this.cacheRepository.increment(
      passwordResetRequestsKey(user.email),
      RESET_REQUESTS_WINDOW_SECONDS
    )
    if (requests > MAX_RESET_REQUESTS_PER_HOUR) {
      throw new ClientError(
        'Muitos pedidos de redefinição para esta conta. Tente novamente mais tarde.',
        429
      )
    }

    const token = randomToken()
    await this.cacheRepository.set(
      passwordResetKey(token),
      { userId: user.id, at: Date.now() },
      PASSWORD_RESET_TTL_SECONDS
    )

    try {
      await this.emailService.sendPasswordResetEmail(
        user.email,
        `${process.env.FRONTEND_URL}/reset-password?token=${token}`
      )
    } catch (error) {
      await this.cacheRepository.del(passwordResetKey(token))
      logError('[PasswordReset] admin request: email delivery failed', error)
      throw new ClientError('Não foi possível enviar o email agora.', 503)
    }
  }

  async requestPasswordReset(email: string) {
    const user = await this.authRepository.findByEmail(email)

    if (!user) return

    const requests = await this.cacheRepository.increment(
      passwordResetRequestsKey(email),
      RESET_REQUESTS_WINDOW_SECONDS
    )
    if (requests > MAX_RESET_REQUESTS_PER_HOUR) return

    const token = randomToken()

    await this.cacheRepository.set(
      passwordResetKey(token),
      { userId: user.id, at: Date.now() },
      PASSWORD_RESET_TTL_SECONDS
    )

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`

    void Promise.resolve(
      this.emailService.sendPasswordResetEmail(user.email, resetUrl)
    ).catch(err => {
      console.error('[PasswordReset] email delivery failed', {
        error: err instanceof Error ? err.message : 'unknown error'
      })
      if (process.env.NODE_ENV !== 'production') {
        console.info('[PasswordReset] dev reset link:', resetUrl)
      }
    })
  }

  private async validPasswordResetUserId(entry: unknown) {
    const userId =
      typeof entry === 'string'
        ? entry
        : (entry as { userId?: unknown } | null)?.userId
    if (typeof userId !== 'string') return null

    const createdAt =
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { at?: unknown }).at === 'number'
        ? (entry as { at: number }).at
        : 0
    const epoch = await this.cacheRepository.get(passwordResetEpochKey(userId))
    if (typeof epoch === 'number' && createdAt < epoch) return null

    return userId
  }

  async isPasswordResetTokenValid(token: string): Promise<boolean> {
    const entry = await this.cacheRepository.get(passwordResetKey(token))
    return (await this.validPasswordResetUserId(entry)) !== null
  }

  async resetPassword(token: string, newPassword: string, ip: string) {
    const userId = await this.validPasswordResetUserId(
      await this.cacheRepository.getdel(passwordResetKey(token))
    )

    if (!userId) {
      throw new ClientError('Link de redefinição inválido ou expirado.', 400)
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_COST)
    const { email } = await this.authRepository.updatePassword(
      userId,
      hashedPassword
    )
    await this.authRepository.markEmailVerified(userId)
    await this.revokeAllSessions(userId)
    await Promise.all([
      this.cacheRepository.del(loginFailuresByEmailKey(email)),
      this.cacheRepository.del(loginFailuresByIpKey(email, ip))
    ])
  }

  private async assertCurrentCredentials(
    user: { id: string; password: string; hasPassword: boolean },
    currentPassword: string | undefined
  ) {
    if (!user.hasPassword) {
      if (!(await this.recentAuthService.isRecent(user.id))) {
        throw new ReauthRequiredError()
      }
      return
    }

    const failuresKey = passwordChangeFailuresKey(user.id)
    const failures = await this.cacheRepository.get(failuresKey)
    if (hasReached(failures, PASSWORD_CHANGE_MAX_FAILURES)) {
      throw new ClientError(
        'Muitas tentativas. Tente novamente mais tarde.',
        429
      )
    }

    if (!currentPassword) {
      throw new ClientError('Informe a senha atual.')
    }

    const matches = await bcrypt.compare(currentPassword, user.password)
    if (!matches) {
      await this.cacheRepository.increment(
        failuresKey,
        PASSWORD_CHANGE_WINDOW_SECONDS
      )
      throw new ClientError('A senha atual está incorreta.')
    }
  }

  private sendInBackground(label: string, send: () => Promise<unknown>) {
    void Promise.resolve()
      .then(send)
      .catch(err => logError(`[${label}] notice email failed`, err))
  }

  async changePassword(
    userId: string,
    input: { currentPassword?: string; newPassword: string }
  ) {
    const user = await this.authRepository.findPasswordState(userId)
    if (!user) throw new ClientError('Conta não encontrada.', 404)

    await this.assertCurrentCredentials(user, input.currentPassword)

    if (user.hasPassword) {
      if (await bcrypt.compare(input.newPassword, user.password)) {
        throw new ClientError('A nova senha precisa ser diferente da atual.')
      }
      await this.cacheRepository.del(passwordChangeFailuresKey(userId))
    }

    const lowered = input.newPassword.toLowerCase()
    const loweredEmail = user.email.toLowerCase()
    if (lowered === loweredEmail || lowered === loweredEmail.split('@')[0]) {
      throw new ClientError('A senha não pode ser igual ao email.')
    }

    const hashedPassword = await bcrypt.hash(input.newPassword, BCRYPT_COST)
    await this.authRepository.updatePassword(userId, hashedPassword)

    await this.revokeAllSessions(userId)
    const tokens = await this.generateTokens(userId)
    await this.recentAuthService.mark(userId)

    this.sendInBackground('PasswordChange', () =>
      this.emailService.sendPasswordChangedEmail(
        user.email,
        `${process.env.FRONTEND_URL}/forgot-password`,
        user.hasPassword
      )
    )

    return { ...tokens, wasSet: !user.hasPassword }
  }

  private async readPendingEmailChange(userId: string) {
    return parsePendingEmailChange(
      await this.cacheRepository.get(emailChangeCurrentKey(userId))
    )
  }

  private async dropPendingEmailChange(
    userId: string,
    pending: PendingEmailChange
  ) {
    await this.cacheRepository.del(emailChangeKey(pending.tokenHash))
    await this.cacheRepository.del(emailChangeCurrentKey(userId))
  }

  private async consumeEmailChangeQuota(userId: string) {
    const requests = await this.cacheRepository.increment(
      emailChangeRequestsKey(userId),
      EMAIL_CHANGE_REQUESTS_WINDOW_SECONDS
    )
    if (requests > EMAIL_CHANGE_MAX_REQUESTS_PER_HOUR) {
      throw new ClientError(
        'Muitos pedidos de troca de e-mail. Tente novamente mais tarde.',
        429
      )
    }
  }

  private async issueEmailChange(userId: string, newEmail: string) {
    const token = randomToken()
    const tokenHash = hashToken(token)
    const previous = await this.readPendingEmailChange(userId)

    await this.cacheRepository.set(
      emailChangeKey(tokenHash),
      { userId, newEmail },
      EMAIL_CHANGE_TTL_SECONDS
    )
    await this.cacheRepository.set(
      emailChangeCurrentKey(userId),
      { tokenHash, newEmail },
      EMAIL_CHANGE_TTL_SECONDS
    )

    const confirmUrl = `${process.env.FRONTEND_URL}/confirm-email-change?token=${token}`

    try {
      await this.emailService.sendEmailChangeConfirmationEmail(
        newEmail,
        confirmUrl
      )
    } catch (err) {
      await this.cacheRepository.del(emailChangeKey(tokenHash))
      if (previous) {
        await this.cacheRepository.set(
          emailChangeCurrentKey(userId),
          previous,
          EMAIL_CHANGE_TTL_SECONDS
        )
      } else {
        await this.cacheRepository.del(emailChangeCurrentKey(userId))
      }
      logError('[EmailChange] email delivery failed', err)
      throw new ClientError('Não foi possível enviar o email agora.', 503)
    }

    const current = await this.readPendingEmailChange(userId)
    if (current?.tokenHash !== tokenHash) {
      await this.cacheRepository.del(emailChangeKey(tokenHash))
      throw new ClientError('A troca de e-mail foi cancelada.', 409)
    }
    if (previous && previous.tokenHash !== tokenHash) {
      await this.cacheRepository.del(emailChangeKey(previous.tokenHash))
    }
  }

  async requestEmailChange(
    userId: string,
    input: { newEmail: string; currentPassword?: string }
  ) {
    const user = await this.authRepository.findPasswordState(userId)
    if (!user) throw new ClientError('Conta não encontrada.', 404)

    await this.assertCurrentCredentials(user, input.currentPassword)
    if (user.hasPassword) {
      await this.cacheRepository.del(passwordChangeFailuresKey(userId))
    }

    const newEmail = normalizeEmail(input.newEmail)
    if (newEmail === normalizeEmail(user.email)) {
      throw new ClientError('Esse já é o e-mail da sua conta.')
    }
    await this.consumeEmailChangeQuota(userId)
    if (await this.authRepository.findByEmail(newEmail)) {
      throw new ClientError(EMAIL_TAKEN_MESSAGE, 409)
    }

    await this.issueEmailChange(userId, newEmail)

    this.sendInBackground('EmailChange', () =>
      this.emailService.sendEmailChangeRequestedNoticeEmail(
        user.email,
        newEmail,
        `${process.env.FRONTEND_URL}/configuracoes/conta`
      )
    )

    return { pendingEmail: newEmail }
  }

  async resendEmailChange(userId: string) {
    const pending = await this.readPendingEmailChange(userId)
    if (!pending) {
      throw new ClientError('Não há troca de e-mail pendente.', 404)
    }

    if (await this.authRepository.findByEmail(pending.newEmail)) {
      await this.dropPendingEmailChange(userId, pending)
      throw new ClientError(EMAIL_TAKEN_MESSAGE, 409)
    }

    await this.consumeEmailChangeQuota(userId)
    await this.issueEmailChange(userId, pending.newEmail)

    return { pendingEmail: pending.newEmail }
  }

  async cancelEmailChange(userId: string) {
    const pending = await this.readPendingEmailChange(userId)
    if (pending) await this.dropPendingEmailChange(userId, pending)
  }

  async confirmEmailChange(token: string) {
    const tokenHash = hashToken(token)
    const entry = (await this.cacheRepository.getdel(
      emailChangeKey(tokenHash)
    )) as { userId?: unknown; newEmail?: unknown } | null

    if (
      !entry ||
      typeof entry.userId !== 'string' ||
      typeof entry.newEmail !== 'string'
    ) {
      throw new ClientError(INVALID_EMAIL_CHANGE_LINK_MESSAGE, 400)
    }
    const { userId, newEmail } = entry

    const pending = await this.readPendingEmailChange(userId)
    if (!pending || pending.tokenHash !== tokenHash) {
      throw new ClientError(INVALID_EMAIL_CHANGE_LINK_MESSAGE, 400)
    }

    const user = await this.authRepository.findById(userId)
    if (!user) throw new ClientError(INVALID_EMAIL_CHANGE_LINK_MESSAGE, 400)

    if (await this.authRepository.findByEmail(newEmail)) {
      await this.dropPendingEmailChange(userId, pending)
      throw new ClientError(EMAIL_TAKEN_MESSAGE, 409)
    }

    try {
      await this.authRepository.updateEmail(userId, newEmail)
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.dropPendingEmailChange(userId, pending)
        throw new ClientError(EMAIL_TAKEN_MESSAGE, 409)
      }
      throw error
    }

    await this.cacheRepository.del(emailChangeCurrentKey(userId))
    const verificationHash = await this.cacheRepository.get(
      emailVerificationCurrentKey(userId)
    )
    if (typeof verificationHash === 'string') {
      await this.cacheRepository.del(emailVerificationKey(verificationHash))
    }
    await this.cacheRepository.del(emailVerificationCurrentKey(userId))
    await this.cacheRepository.set(
      passwordResetEpochKey(userId),
      Date.now(),
      PASSWORD_RESET_TTL_SECONDS
    )
    await this.revokeAllSessions(userId)

    this.sendInBackground('EmailChange', () =>
      this.emailService.sendEmailChangedNoticeEmail(
        user.email,
        newEmail,
        `${process.env.FRONTEND_URL}/contato`
      )
    )

    return { email: newEmail }
  }

  private providerIdOf(
    user: { googleId: string | null; discordId: string | null },
    provider: OAuthProvider
  ) {
    return provider === 'google' ? user.googleId : user.discordId
  }

  private async requireRecentSignIn(userId: string) {
    if (!(await this.recentAuthService.isRecent(userId))) {
      throw new ReauthRequiredError()
    }
  }

  async assertCanLinkProvider(userId: string, provider: OAuthProvider) {
    const user = await this.authRepository.findProviderState(userId)
    if (!user) throw new ClientError('Conta não encontrada.', 404)
    await this.requireRecentSignIn(userId)
    if (this.providerIdOf(user, provider)) {
      throw new ProviderLinkError(
        'ja_ligado',
        `O ${PROVIDER_LABEL[provider]} já está vinculado à sua conta.`
      )
    }
  }

  async linkProviderToUser(
    userId: string,
    provider: OAuthProvider,
    providerId: string,
    verifiedByProvider: boolean
  ) {
    const label = PROVIDER_LABEL[provider]
    if (!verifiedByProvider) {
      throw new ProviderLinkError(
        'email_nao_verificado',
        'O email dessa conta não foi verificado pelo provedor.'
      )
    }

    const user = await this.authRepository.findProviderState(userId)
    if (!user) throw new ClientError('Conta não encontrada.', 404)
    if (this.providerIdOf(user, provider)) {
      throw new ProviderLinkError(
        'ja_ligado',
        `O ${label} já está vinculado à sua conta.`
      )
    }

    const owner =
      provider === 'google'
        ? await this.authRepository.findUserByGoogleId(providerId)
        : await this.authRepository.findByDiscordId(providerId)
    if (owner && owner.id !== userId) {
      throw new ProviderLinkError(
        'ja_ligado_outra_conta',
        `Este ${label} já está ligado a outra conta do EuZerei.`
      )
    }

    try {
      const attached = await this.authRepository.attachProvider(
        userId,
        provider,
        providerId
      )
      if (!attached) {
        throw new ProviderLinkError(
          'ja_ligado',
          `O ${label} já está vinculado à sua conta.`
        )
      }
    } catch (error) {
      if (error instanceof ProviderLinkError) throw error
      if (isUniqueViolation(error)) {
        throw new ProviderLinkError(
          'ja_ligado_outra_conta',
          `Este ${label} já está ligado a outra conta do EuZerei.`
        )
      }
      throw error
    }

    this.sendInBackground('ProviderLink', () =>
      this.emailService.sendProviderChangedNoticeEmail(
        user.email,
        label,
        true,
        `${process.env.FRONTEND_URL}/configuracoes/seguranca`
      )
    )
  }

  async unlinkProvider(
    userId: string,
    provider: OAuthProvider,
    currentPassword?: string
  ) {
    const label = PROVIDER_LABEL[provider]
    const user = await this.authRepository.findProviderState(userId)
    if (!user) throw new ClientError('Conta não encontrada.', 404)
    await this.requireRecentSignIn(userId)

    if (!this.providerIdOf(user, provider)) {
      throw new ClientError(`O ${label} não está vinculado à sua conta.`, 404)
    }

    const methods =
      (user.hasPassword ? 1 : 0) +
      (user.googleId ? 1 : 0) +
      (user.discordId ? 1 : 0)
    if (methods <= 1) {
      throw new ClientError(
        `Defina uma senha antes de desvincular o ${label}.`,
        409
      )
    }

    const otherProviderId =
      provider === 'google' ? user.discordId : user.googleId
    if (user.hasPassword && !otherProviderId) {
      const passwordState = await this.authRepository.findPasswordState(userId)
      if (!passwordState) throw new ClientError('Conta não encontrada.', 404)
      await this.assertCurrentCredentials(passwordState, currentPassword)
      await this.cacheRepository
        .del(passwordChangeFailuresKey(userId))
        .catch(() => undefined)
    }

    const detached = await this.authRepository.detachProviderKeepingAMethod(
      userId,
      provider
    )
    if (!detached) {
      const fresh = await this.authRepository.findProviderState(userId)
      if (fresh && !this.providerIdOf(fresh, provider)) return null
      throw new ClientError(
        `Defina uma senha antes de desvincular o ${label}.`,
        409
      )
    }
    await this.authRepository.deleteTokensByUserId(userId)
    await markSessionsRevoked(this.cacheRepository, userId)
    try {
      await this.cancelEmailChange(userId)
    } catch (error) {
      logError('[ProviderUnlink] pending e-mail change not cancelled:', error)
    }

    this.sendInBackground('ProviderUnlink', () =>
      this.emailService.sendProviderChangedNoticeEmail(
        user.email,
        label,
        false,
        `${process.env.FRONTEND_URL}/configuracoes/seguranca`
      )
    )

    const tokens = await this.generateTokens(userId)
    await this.recentAuthService.mark(userId)
    return tokens
  }

  async logout(refreshToken?: string, accessToken?: string) {
    if (refreshToken) {
      await this.authRepository.invalidateToken(refreshToken)
    }

    if (!accessToken) return

    let ttlSeconds: number
    try {
      const decoded = this.jwt.verify(accessToken) as { exp: number }
      ttlSeconds = decoded.exp - Math.floor(Date.now() / 1000)
    } catch {
      return
    }

    if (ttlSeconds <= 0) return

    try {
      await this.cacheRepository.set(
        revokedAccessTokenKey(accessToken),
        true,
        ttlSeconds
      )
    } catch (error) {
      console.error('[Auth] access token revocation failed at logout', {
        error: error instanceof Error ? error.message : 'unknown error'
      })
    }
  }
}
