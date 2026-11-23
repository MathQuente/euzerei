import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ReviewService } from '../services/review.service'
import { ReviewController } from '../controllers/review.controller'
import { ReviewRepository } from '../repositories/review.repository'
import { UserRepository } from '../repositories/users.repository'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { GameCacheService } from '../services/game-cache.service'
import * as ReviewSchema from '../schemas/review.schema'
import { userRateLimit } from '../utils/user-rate-limit'
import { ErrorSchemas } from '../schemas/error.schema'

export async function reviewRoutes(app: FastifyInstance) {
  const reviewRepository = new ReviewRepository()
  const userRepository = new UserRepository()
  const gameCacheService = new GameCacheService(new GameCacheRepository())
  const reviewService = new ReviewService(
    reviewRepository,
    userRepository,
    gameCacheService
  )
  const reviewController = new ReviewController(reviewService)

  app.withTypeProvider<ZodTypeProvider>().post(
    '/:igdbId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: ReviewSchema.ReviewParamsSchema,
        response: {
          200: ReviewSchema.UpsertReviewResponseSchema,
          400: ErrorSchemas.BadRequest,
          404: ErrorSchemas.NotFound,
          500: ErrorSchemas.InternalServerError
        }
      }
    },
    async (request, reply) => reviewController.upsertReview(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().get(
    '/:igdbId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: ReviewSchema.ReviewParamsSchema,
        response: {
          200: ReviewSchema.GetReviewResponseSchema,
          500: ErrorSchemas.InternalServerError
        }
      }
    },
    async (request, reply) => reviewController.getOwnReview(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().delete(
    '/:igdbId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: ReviewSchema.ReviewParamsSchema,
        response: {
          204: ReviewSchema.DeleteReviewResponseSchema,
          404: ErrorSchemas.NotFound,
          500: ErrorSchemas.InternalServerError
        }
      }
    },
    async (request, reply) => reviewController.deleteReview(request, reply)
  )

  // onRequest (not preHandler): Fastify validates before preHandler, so a
  // stranger with a bad body would get a 400 instead of a 401.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/:igdbId/authors/:authorId/reports',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: userRateLimit('review-report', 10, '1 hour') },
      schema: {
        params: ReviewSchema.ReportReviewParamsSchema,
        body: ReviewSchema.ReportReviewBodySchema,
        response: {
          201: ReviewSchema.ReportReviewResponseSchema,
          400: ErrorSchemas.BadRequest,
          404: ErrorSchemas.NotFound,
          500: ErrorSchemas.InternalServerError
        }
      }
    },
    async (request, reply) => reviewController.reportReview(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().get(
    '/:igdbId/community',
    {
      preHandler: [app.tryAuthenticate],
      schema: {
        params: ReviewSchema.ReviewParamsSchema,
        querystring: ReviewSchema.CommunityReviewsQueryStringSchema,
        response: {
          200: ReviewSchema.GetCommunityReviewsResponseSchema,
          500: ErrorSchemas.InternalServerError
        }
      }
    },
    async (request, reply) =>
      reviewController.getCommunityReviews(request, reply)
  )
}
