import { JWT } from '@fastify/jwt'
import { ClientError } from '../errors/client-error'
import { AdminRepository } from '../repositories/admin.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { AuditService } from './audit.service'
import { AuthService, revokedAccessTokenKey } from './auth.service'
import { PANEL_TOKEN_TTL, passwordFingerprint } from '../utils/panel-token'
import { logError } from '../utils/respond-unavailable'

const INVALID_CREDENTIALS_MESSAGE = 'Email ou senha incorretos.'
const UNAVAILABLE_MESSAGE =
  'Serviço indisponível no momento. Tente novamente em instantes.'

export class PanelAuthService {
  constructor(
    private authService: Pick<AuthService, 'validateUser'>,
    private adminRepository: AdminRepository,
    private jwt: JWT,
    private cacheRepository: CacheRepository,
    private auditService: AuditService
  ) {}

  async login(email: string, password: string, ip: string) {
    let userId: string
    try {
      const { user } = await this.authService.validateUser(email, password, ip)
      userId = user.id
    } catch (error) {
      if (error instanceof ClientError && error.statusCode === 400) {
        throw new ClientError(INVALID_CREDENTIALS_MESSAGE, 401)
      }
      throw error
    }

    const admin = await this.adminRepository.findById(userId)

    if (!admin || admin.role !== 'ADMIN') {
      await this.auditService.record({
        actorId: admin?.id ?? null,
        action: 'Tentou entrar no painel sem ser admin',
        area: 'SYSTEM',
        target: admin ? `@${admin.userName}` : null,
        result: 'FAILED',
        ip
      })
      throw new ClientError(INVALID_CREDENTIALS_MESSAGE, 401)
    }

    const token = this.jwt.sign(
      {
        userId: admin.id,
        tokenType: 'panel',
        pv: passwordFingerprint(admin.password)
      },
      { expiresIn: PANEL_TOKEN_TTL }
    )

    await this.auditService.record({
      actorId: admin.id,
      action: 'Entrou no painel',
      area: 'SYSTEM',
      target: `@${admin.userName}`,
      ip
    })

    return {
      user: { id: admin.id, name: admin.userName, email: admin.email },
      token
    }
  }

  async logout(token: string, userId: string, ip: string) {
    let ttlSeconds: number
    try {
      const decoded = this.jwt.verify(token) as { exp: number }
      ttlSeconds = decoded.exp - Math.floor(Date.now() / 1000)
    } catch {
      return
    }

    if (ttlSeconds > 0) {
      try {
        await this.cacheRepository.set(
          revokedAccessTokenKey(token),
          true,
          ttlSeconds
        )
      } catch (error) {
        logError('[Panel] token revocation failed at logout', error)
        throw new ClientError(UNAVAILABLE_MESSAGE, 503)
      }
    }

    await this.auditService.record({
      actorId: userId,
      action: 'Saiu do painel',
      area: 'SYSTEM',
      ip
    })
  }

  async profile(userId: string) {
    const admin = await this.adminRepository.findById(userId)
    if (!admin) return null
    return {
      id: admin.id,
      name: admin.userName,
      email: admin.email,
      role: admin.role
    }
  }
}
