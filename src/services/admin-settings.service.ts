import { AdminUsersRepository } from '../repositories/admin-users.repository'
import { AdminUpdateSettingsBodySchema } from '../schemas/admin-settings.schema'
import { TERMS_VERSION } from '../utils/terms'
import { AppSettingsService } from './app-settings.service'

export class AdminSettingsService {
  constructor(
    private appSettingsService: AppSettingsService = new AppSettingsService(),
    private adminUsersRepository: AdminUsersRepository = new AdminUsersRepository()
  ) {}

  async get() {
    const [settings, termsPending] = await Promise.all([
      this.appSettingsService.getAll(),
      this.adminUsersRepository.countWithoutCurrentTerms()
    ])

    return {
      settings: { ...settings, termsVersion: TERMS_VERSION },
      termsPending
    }
  }

  async update(actorId: string, input: unknown, ip: string) {
    const body = AdminUpdateSettingsBodySchema.parse(input)

    const { changed } = await this.appSettingsService.update(actorId, body, ip)

    return { ...(await this.get()), changed }
  }
}
