import {
  AuditRepository,
  type AuditEntryInput
} from '../repositories/audit.repository'
import { logError } from '../utils/respond-unavailable'

export class AuditService {
  constructor(
    private auditRepository: AuditRepository = new AuditRepository()
  ) {}

  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.auditRepository.create(entry)
    } catch (error) {
      logError('[Audit] could not record entry', error)
    }
  }
}
