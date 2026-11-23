import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '../database/prisma-client'
import { ClientError } from '../errors/client-error'
import { ReviewRepository } from '../repositories/review.repository'
import { UserRepository } from '../repositories/users.repository'
import { GameCacheService } from './game-cache.service'
import { ReviewService } from './review.service'

const UPDATED = new Date('2026-11-20T10:00:00Z')

function build(repo: Partial<Record<keyof ReviewRepository, unknown>> = {}) {
  const reviewRepository = {
    findByUserGame: vi
      .fn()
      .mockResolvedValue({ id: 'rv-1', updatedAt: UPDATED }),
    createReport: vi.fn().mockResolvedValue({ id: 'rp-1' }),
    ...repo
  }
  const service = new ReviewService(
    reviewRepository as unknown as ReviewRepository,
    {} as UserRepository,
    {} as GameCacheService
  )
  return { service, reviewRepository }
}

describe('ReviewService.reportReview', () => {
  it('stores the report with the review updatedAt of that moment', async () => {
    const { service, reviewRepository } = build()

    const result = await service.reportReview(7, 'author', 'reporter', 'SPAM')

    expect(result).toEqual({ reported: true })
    expect(reviewRepository.findByUserGame).toHaveBeenCalledWith(7, 'author')
    expect(reviewRepository.createReport).toHaveBeenCalledWith({
      reviewId: 'rv-1',
      reporterId: 'reporter',
      reason: 'SPAM',
      reviewUpdatedAt: UPDATED
    })
  })

  it('refuses to report your own review with a 403, before reading anything', async () => {
    const { service, reviewRepository } = build()

    await expect(
      service.reportReview(7, 'same', 'same', 'SPAM')
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(reviewRepository.findByUserGame).not.toHaveBeenCalled()
  })

  it('answers 404 when the review does not exist', async () => {
    const { service, reviewRepository } = build({
      findByUserGame: vi.fn().mockResolvedValue(null)
    })

    await expect(
      service.reportReview(7, 'author', 'reporter', 'SPAM')
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(reviewRepository.createReport).not.toHaveBeenCalled()
  })

  it('answers 404 when the review is hidden: it left the game page, so the reporter no longer sees it', async () => {
    const { service, reviewRepository } = build({
      findByUserGame: vi.fn().mockResolvedValue({
        id: 'rv-1',
        updatedAt: UPDATED,
        hiddenAt: new Date()
      })
    })

    await expect(
      service.reportReview(7, 'author', 'reporter', 'SPAM')
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(reviewRepository.createReport).not.toHaveBeenCalled()
  })

  it('answers 409 when the same person already reported it', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x'
    })
    const { service } = build({
      createReport: vi.fn().mockRejectedValue(duplicate)
    })

    const error = await service
      .reportReview(7, 'author', 'reporter', 'SPAM')
      .catch(e => e)

    expect(error).toBeInstanceOf(ClientError)
    expect(error.statusCode).toBe(409)
  })

  it('lets any other failure through', async () => {
    const { service } = build({
      createReport: vi.fn().mockRejectedValue(new Error('db down'))
    })

    await expect(
      service.reportReview(7, 'author', 'reporter', 'SPAM')
    ).rejects.toThrow('db down')
  })
})
