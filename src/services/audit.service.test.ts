import { describe, it, expect, vi, afterEach } from 'vitest'
import { AuditService } from './audit.service'
import type { AuditRepository } from '../repositories/audit.repository'

afterEach(() => vi.restoreAllMocks())

describe('AuditService.record', () => {
  it('writes the entry through the repository', async () => {
    const create = vi.fn().mockResolvedValue({})
    const service = new AuditService({ create } as unknown as AuditRepository)

    await service.record({
      actorId: 'admin-1',
      action: 'Entrou no painel',
      area: 'SYSTEM',
      ip: '1.2.3.4'
    })

    expect(create).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Entrou no painel',
      area: 'SYSTEM',
      ip: '1.2.3.4'
    })
  })

  it('logs and swallows a failure, so the audited action is not broken', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const create = vi.fn().mockRejectedValue(new Error('database down'))
    const service = new AuditService({ create } as unknown as AuditRepository)

    await expect(
      service.record({ actorId: null, action: 'x', area: 'SYSTEM' })
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('[Audit] could not record entry', {
      error: 'database down'
    })
  })
})
