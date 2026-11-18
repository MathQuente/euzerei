import { Platform, Status } from '../database/prisma-client'
import { UpdateUserDTO } from '../dtos/user.dto'
import { ClientError } from '../errors/client-error'
import { isRecordNotFound, isUniqueViolation } from '../utils/prisma-errors'
import { RatingRepository } from '../repositories/rating.repository'
import { QUEUE_FILTER, UserRepository } from '../repositories/users.repository'
import { FollowRepository } from '../repositories/follow.repository'
import { FavoriteGameRow, PaginatedUserGameRow } from '../types/user'
import { IGDBService } from './igdb.service'
import { CloudinaryService } from './cloudinary.service'
import { GameCacheService } from './game-cache.service'
import { UserGamePlatformRepository } from '../repositories/user-game-platform.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { markSessionsRevoked } from '../utils/session-revocation'
import {
  emailChangeCurrentKey,
  parsePendingEmailChange
} from '../utils/email-change'
import { logError } from '../utils/respond-unavailable'
import { randomInt } from 'crypto'
import {
  ENDLESS_COMPLETIONS_MESSAGE,
  MAX_FAVORITE_GAMES,
  PLAYED_STATUS_ID,
  WISHLIST_STATUS_ID
} from '../utils/library-status'

const EDIT_BY_PLATFORM_MESSAGE =
  'Este jogo tem plataformas cadastradas. Edite os valores por plataforma.'

export class UserService {
  private readonly ITEMS_PER_PAGE = 30
  private readonly USER_GAMES_PER_PAGE = 48
  private readonly LIBRARY_PREVIEW_PER_STATUS = 24

  constructor(
    private userRepository: UserRepository,
    private ratingRepository: RatingRepository,
    private gameCacheService: GameCacheService,
    private followRepository: FollowRepository,
    private platformRepository: UserGamePlatformRepository = new UserGamePlatformRepository(),
    private cacheRepository: CacheRepository = new CacheRepository()
  ) {}

  private async requireUser(userId: string) {
    const user = await this.userRepository.findUserById(userId)
    if (!user) throw new ClientError('Usuário não encontrado.', 404)
    return user
  }

  async addGameToUserLibrary(
    igdbId: number,
    userId: string,
    statusIds: number
  ) {
    await this.requireUser(userId)

    const gameExists = await this.gameCacheService.ensureCached(igdbId)
    if (!gameExists) throw new ClientError('Jogo não encontrado.', 404)

    const existing = await this.userRepository.findUserGame(igdbId, userId)

    if (existing)
      throw new ClientError('Este jogo já está na sua biblioteca.', 409)

    const endless = await this.gameCacheService.suggestsEndless(igdbId)

    let addedId: number
    try {
      ;({ igdbId: addedId } = await this.userRepository.addGameToUserLibrary({
        igdbId,
        statusIds,
        userId,
        endless
      }))
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ClientError('Este jogo já está na sua biblioteca.', 409)
      }
      throw err
    }

    await this.userRepository.createUserGameStats(
      userId,
      igdbId,
      statusIds === PLAYED_STATUS_ID ? 1 : 0
    )

    return { igdbId: addedId }
  }

  async delete(userId: string) {
    const existing = await this.requireUser(userId)

    const user = await this.userRepository.deleteUser(userId)

    try {
      await markSessionsRevoked(this.cacheRepository, userId)
    } catch (error) {
      console.error('Session revocation after account deletion failed:', {
        error: error instanceof Error ? error.message : 'unknown error'
      })
    }

    await this.destroyOwnedImages([
      existing.profilePicture,
      existing.userBanner
    ])

    return { user }
  }

  private async destroyOwnedImages(urls: (string | null | undefined)[]) {
    if (!CloudinaryService.isConfigured()) return

    try {
      const candidates = [
        ...new Set(urls.filter((url): url is string => !!url))
      ].filter(url => CloudinaryService.publicIdFromUrl(url) !== null)
      if (candidates.length === 0) return

      const inUse = new Set(
        await this.userRepository.findImageUrlsInUse(candidates)
      )

      for (const url of candidates) {
        if (inUse.has(url)) continue
        try {
          await CloudinaryService.destroy(
            CloudinaryService.publicIdFromUrl(url)!
          )
        } catch (error) {
          this.logImageRemovalFailure(error)
        }
      }
    } catch (error) {
      this.logImageRemovalFailure(error)
    }
  }

  private logImageRemovalFailure(error: unknown) {
    console.error('Cloudinary image removal failed:', {
      error: error instanceof Error ? error.message : 'unknown error'
    })
  }

  private async readPendingEmail(userId: string) {
    try {
      const pending = parsePendingEmailChange(
        await this.cacheRepository.get(emailChangeCurrentKey(userId))
      )
      return pending?.newEmail ?? null
    } catch (error) {
      logError('Pending email read failed:', error)
      return null
    }
  }

  private storeNames(accounts: { platform: Platform; displayName: string }[]) {
    const namesOf = (platform: Platform) =>
      accounts.filter(a => a.platform === platform).map(a => a.displayName)

    return {
      steam: namesOf(Platform.STEAM),
      playstation: namesOf(Platform.PLAYSTATION),
      xbox: namesOf(Platform.XBOX)
    }
  }

  private achievementStats(
    accounts: {
      platform: Platform
      achievementsEarned: number | null
      gamerscore: number | null
      platinumTrophies: number | null
    }[]
  ) {
    // Soma as contas da mesma loja. null = alguma conta dela ainda não tem o
    // número (não importada depois da migration): melhor "sem número" do que
    // um total parcial que parece completo.
    const sum = (
      platform: Platform,
      field: 'achievementsEarned' | 'gamerscore' | 'platinumTrophies'
    ) => {
      const ofStore = accounts.filter(a => a.platform === platform)
      const values = ofStore.map(a => a[field])
      if (values.length === 0 || values.some(v => typeof v !== 'number')) {
        return null
      }
      return (values as number[]).reduce((n, v) => n + v, 0)
    }

    const steam = sum(Platform.STEAM, 'achievementsEarned')
    const xboxScore = sum(Platform.XBOX, 'gamerscore')
    const xboxAchievements = sum(Platform.XBOX, 'achievementsEarned')
    const psnTrophies = sum(Platform.PLAYSTATION, 'achievementsEarned')
    const psnPlatinum = sum(Platform.PLAYSTATION, 'platinumTrophies')

    return {
      steam: steam === null ? null : { achievements: steam },
      xbox:
        xboxScore === null
          ? null
          : { gamerscore: xboxScore, achievements: xboxAchievements ?? 0 },
      psn:
        psnTrophies === null
          ? null
          : { trophies: psnTrophies, platinum: psnPlatinum ?? 0 }
    }
  }

  async findMe(userId: string) {
    const user = await this.requireUser(userId)

    const [
      totalHoursPlayed,
      hundredPercentCount,
      followersCount,
      followingCount,
      pendingEmail
    ] = await Promise.all([
      this.userRepository.sumUserHoursPlayed(userId),
      this.userRepository.countHundredPercent(userId),
      this.followRepository.countFollowers(userId),
      this.followRepository.countFollowing(userId),
      this.readPendingEmail(userId)
    ])

    return {
      user: {
        id: user.id,
        profilePicture: user.profilePicture,
        userName: user.userName,
        userBanner: user.userBanner,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        hasPassword: user.hasPassword,
        googleLinked: Boolean(user.googleId),
        discordLinked: Boolean(user.discordId),
        pendingEmail,
        gamesAmount: user._count.userGames,
        totalHoursPlayed: totalHoursPlayed ? Number(totalHoursPlayed) : 0,
        hundredPercentCount,
        createdAt: user.createdAt.toISOString(),
        achievementStats: this.achievementStats(user.accounts),
        steamAccounts: user.accounts
          .filter(account => account.platform === 'STEAM')
          .map(account => ({
            id: account.id,
            steamId: account.externalId,
            personaName: account.displayName
          })),
        psnAccounts: user.accounts
          .filter(account => account.platform === 'PLAYSTATION')
          .map(account => ({ id: account.id, onlineId: account.displayName })),
        xboxAccounts: user.accounts
          .filter(account => account.platform === 'XBOX')
          .map(account => ({
            id: account.id,
            gamertag: account.displayName,
            preferredConsole: account.preferredConsole
          })),
        followersCount,
        followingCount
      }
    }
  }

  async findById(userId: string) {
    const user = await this.requireUser(userId)

    const [
      totalHoursPlayed,
      hundredPercentCount,
      followersCount,
      followingCount
    ] = await Promise.all([
      this.userRepository.sumUserHoursPlayed(userId),
      this.userRepository.countHundredPercent(userId),
      this.followRepository.countFollowers(userId),
      this.followRepository.countFollowing(userId)
    ])

    return {
      user: {
        id: user.id,
        profilePicture: user.profilePicture,
        userBanner: user.userBanner,
        userName: user.userName,
        // findUserById já conta fora da lista de desejos (NOT_WISHLIST).
        gamesAmount: user._count.userGames,
        totalHoursPlayed: totalHoursPlayed ? Number(totalHoursPlayed) : 0,
        hundredPercentCount,
        createdAt: user.createdAt.toISOString(),
        stores: this.storeNames(user.accounts),
        achievementStats: this.achievementStats(user.accounts),
        followersCount,
        followingCount
      }
    }
  }

  async findUserGameStatus(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const userGameStatus = await this.userRepository.findUserGameStatus(
      igdbId,
      userId
    )

    return {
      userGameStatus: userGameStatus?.UserGamesStatus || null,
      endless: userGameStatus?.endless ?? false,
      hundredPercent: userGameStatus?.hundredPercent ?? false,
      hoursPlayed: Number(userGameStatus?.UserGameStats?.hoursPlayed ?? 0),
      completions: userGameStatus?.UserGameStats?.completions ?? 0
    }
  }

  async setEndless(igdbId: number, userId: string, endless: boolean) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGame(igdbId, userId)
    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    try {
      return await this.userRepository.setEndless(igdbId, userId, endless)
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)
      }
      throw error
    }
  }

  async getFavorites(userId: string) {
    await this.requireUser(userId)

    const rows: FavoriteGameRow[] =
      await this.userRepository.findFavoriteGameRows(userId)
    const enriched = await this.fillMissingGameCacheEntries(rows)
    const mainId = rows.find(row => row.isMain)?.igdbId
    const games = enriched.map(game => ({
      ...game,
      isMain: game.igdbId === mainId
    }))
    return { games }
  }

  async findRouletteGames(
    userId: string,
    { count, exclude }: { count: number; exclude?: number }
  ) {
    await this.requireUser(userId)

    const total = await this.userRepository.countGamesOfUser({
      userId,
      filter: Status.BACKLOG
    })
    const excludeIgdbId =
      exclude !== undefined && total > count ? exclude : undefined

    const rows = await this.userRepository.findManyGamesOfUser({
      userId,
      filter: Status.BACKLOG,
      skip: 0,
      take: count,
      randomOrder: true,
      excludeIgdbId
    })
    const games =
      await this.fillMissingGameCacheEntries<PaginatedUserGameRow>(rows)

    return { total, games }
  }

  async setFavorites(
    userId: string,
    igdbIds: number[],
    mainIgdbId: number | null = null
  ) {
    await this.requireUser(userId)

    if (igdbIds.length > MAX_FAVORITE_GAMES) {
      throw new ClientError(
        `Escolha no máximo ${MAX_FAVORITE_GAMES} jogos favoritos.`
      )
    }
    if (new Set(igdbIds).size !== igdbIds.length) {
      throw new ClientError('Um jogo não pode aparecer duas vezes.')
    }

    if (mainIgdbId !== null && !igdbIds.includes(mainIgdbId)) {
      throw new ClientError('O jogo com a coroa precisa estar nos favoritos.')
    }

    const known = await Promise.all(
      igdbIds.map(igdbId => this.gameCacheService.ensureCached(igdbId))
    )
    if (known.some(isKnown => !isKnown)) {
      throw new ClientError('Um dos jogos escolhidos não foi encontrado.')
    }

    try {
      await this.userRepository.replaceFavorites(userId, igdbIds, mainIgdbId)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ClientError(
          'Outra alteração dos favoritos estava em andamento. Tente de novo.',
          409
        )
      }
      throw error
    }

    return this.getFavorites(userId)
  }

  async setHundredPercent(igdbId: number, userId: string, value: boolean) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGameStatus(
      igdbId,
      userId
    )
    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    if (value && userGame.UserGamesStatus?.id !== PLAYED_STATUS_ID) {
      throw new ClientError(
        'Só um jogo marcado como Jogado pode ser concluído a 100%.',
        409
      )
    }

    const result = await this.userRepository.setHundredPercent(
      igdbId,
      userId,
      value
    )
    if (!result) {
      throw new ClientError(
        value
          ? 'Só um jogo marcado como Jogado pode ser concluído a 100%.'
          : 'Jogo não encontrado na sua biblioteca.',
        value ? 409 : 404
      )
    }
    return result
  }

  async findManyUsers(pageIndex: number, query: string | undefined) {
    const users = await this.userRepository.findManyUsers({
      pageIndex,
      limit: this.ITEMS_PER_PAGE,
      query
    })

    return {
      users: users.map(user => ({
        id: user.id,
        userBanner: user.userBanner,
        userName: user.userName,
        profilePicture: user.profilePicture,
        userGamesAmount: user._count.userGames
      }))
    }
  }

  async findManyUserGames(
    userId: string,
    pageIndex: number,
    filter: Status | typeof QUEUE_FILTER | undefined,
    query: string | undefined,
    sortBy:
      | 'gameName'
      | 'dateRelease'
      | 'rating'
      | 'dateAdded'
      | 'hoursPlayed'
      | 'completedAt' = 'dateAdded',
    sortOrder: 'asc' | 'desc' = sortBy === 'dateAdded' ||
    sortBy === 'completedAt'
      ? 'desc'
      : 'asc',
    options: {
      previewPerStatus?: number
      includeLibraryIds?: boolean
      platforms?: Platform[]
      excludeStatuses?: Status[]
    } = {}
  ) {
    await this.requireUser(userId)

    const platforms = options.platforms?.length ? options.platforms : undefined
    const { excludeStatuses } = options
    const isOverview = !filter && !query && !platforms
    const previewPerStatus = isOverview
      ? (options.previewPerStatus ?? this.LIBRARY_PREVIEW_PER_STATUS)
      : undefined

    const rows = await this.userRepository.findManyGamesOfUser({
      userId,
      filter,
      query,
      platforms,
      excludeStatuses,
      sortBy,
      sortOrder,
      skip: filter ? pageIndex * this.USER_GAMES_PER_PAGE : undefined,
      take: filter ? this.USER_GAMES_PER_PAGE : undefined,
      previewPerStatus,
      uncappedStatuses:
        previewPerStatus === undefined ? undefined : [Status.PLAYING]
    })

    const enriched =
      await this.fillMissingGameCacheEntries<PaginatedUserGameRow>(rows)

    const games: Record<string, typeof enriched> = {
      PLAYED: [],
      PLAYING: [],
      PAUSED: [],
      BACKLOG: [],
      WISHLIST: [],
      DROPPED: []
    }

    for (const entry of enriched) {
      const group = filter === QUEUE_FILTER ? Status.BACKLOG : entry.status
      if (group in games) {
        games[group].push(entry)
      }
    }

    const includeLibraryIds = isOverview && (options.includeLibraryIds ?? true)
    const [totalPerStatus, libraryIgdbIds, matchingTotal] = await Promise.all([
      this.userRepository.findGamesCountByStatus(userId),
      includeLibraryIds
        ? this.userRepository.findLibraryIgdbIds(userId)
        : undefined,
      query || platforms
        ? this.userRepository.countGamesOfUser({
            userId,
            filter,
            query,
            platforms,
            excludeStatuses
          })
        : undefined
    ])

    const totalPerStatusMapped = totalPerStatus
      .filter(item => !excludeStatuses?.includes(item.status))
      .map(item => ({
        status: item.status,
        totalGames: item._count.userGames
      }))

    const countOf = (status: string) =>
      totalPerStatusMapped.find(t => t.status === status)?.totalGames ?? 0
    const total =
      matchingTotal ??
      (filter === QUEUE_FILTER
        ? countOf(Status.BACKLOG) + countOf(Status.DROPPED)
        : filter
          ? countOf(filter)
          : totalPerStatusMapped.reduce((acc, t) => acc + t.totalGames, 0))

    return {
      games,
      totalPerStatus: totalPerStatusMapped,
      total,
      ...(libraryIgdbIds ? { libraryIgdbIds } : {})
    }
  }

  private readonly PUBLIC_PROFILE_PREVIEW_PER_STATUS = 6

  async findPublicUserGames(userId: string) {
    return this.findManyUserGames(
      userId,
      0,
      undefined,
      undefined,
      'completedAt',
      'desc',
      {
        previewPerStatus: this.PUBLIC_PROFILE_PREVIEW_PER_STATUS,
        includeLibraryIds: false,
        // Largados só aparecem para o dono: a interface pública já os esconde.
        excludeStatuses: [Status.DROPPED]
      }
    )
  }

  async findUserFollowers(userId: string) {
    await this.requireUser(userId)
    const followers = await this.followRepository.findFollowers(userId)
    return { followers }
  }

  async findUserFollowing(userId: string) {
    await this.requireUser(userId)
    const following = await this.followRepository.findFollowing(userId)
    return { following }
  }

  private async fillMissingGameCacheEntries<
    R extends Omit<PaginatedUserGameRow, 'status'> & { status: Status | null }
  >(rows: R[]) {
    const missing = rows.filter(r => r.name === null)

    const fetched =
      missing.length > 0
        ? await IGDBService.getGamesByIds(missing.map(r => r.igdbId))
        : []
    const fetchedMap = new Map(fetched.map(g => [g.id, g]))

    if (fetched.length > 0) {
      this.gameCacheService
        .cacheMany(fetched)
        .catch(err => console.error('[GameCache] cacheMany failed', err))
    }

    return rows
      .map(r => {
        if (r.name !== null) {
          return {
            igdbId: r.igdbId,
            slug: r.slug,
            name: r.name,
            coverUrl: r.coverUrl,
            platforms: r.platforms ?? undefined,
            releaseDate: r.releaseDate ?? undefined,
            rating: r.rating,
            completions: r.completions,
            hoursPlayed: r.hoursPlayed,
            playedOn: r.playedOn ?? [],
            status: r.status as R['status'],
            endless: r.endless,
            hundredPercent: r.hundredPercent,
            updatedAt: r.updatedAt?.toISOString()
          }
        }

        const g = fetchedMap.get(r.igdbId)
        if (!g) return null

        return {
          igdbId: r.igdbId,
          slug: null,
          name: g.name,
          coverUrl: IGDBService.formatCoverUrl(g.cover?.url),
          platforms: g.platforms?.map(p => p.name),
          releaseDate: g.first_release_date,
          rating: r.rating,
          completions: r.completions,
          hoursPlayed: r.hoursPlayed,
          playedOn: r.playedOn ?? [],
          status: r.status as R['status'],
          endless: r.endless,
          hundredPercent: r.hundredPercent,
          updatedAt: r.updatedAt?.toISOString()
        }
      })
      .filter((g): g is NonNullable<typeof g> => g !== null)
  }

  async removeGame(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const existing = await this.userRepository.findUserGame(igdbId, userId)

    if (!existing)
      throw new ClientError('Este jogo não está na sua biblioteca.', 409)

    const { igdbId: removedId } = await this.userRepository.removeGame(
      igdbId,
      userId
    )

    const rating = await this.ratingRepository.findUniqueByUserGame(
      igdbId,
      userId
    )
    if (rating) await this.ratingRepository.delete(igdbId, userId)

    return { igdbId: removedId }
  }

  async updateGame(igdbId: number, userId: string, statusId: number) {
    if (!statusId) throw new ClientError('Você precisa informar o status.', 400)

    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGame(igdbId, userId)

    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    const currentStatus = userGame.UserGamesStatus.id
    const hasPlatforms = (userGame._count?.platforms ?? 0) > 0

    if (
      statusId === WISHLIST_STATUS_ID &&
      currentStatus !== WISHLIST_STATUS_ID
    ) {
      const { igdbId: updatedId, UserGamesStatus } =
        await this.userRepository.moveToWishlist(igdbId, userId, statusId)

      return {
        igdbId: updatedId,
        userGameStatus: UserGamesStatus,
        playedCountUpdated: 0
      }
    }

    if (hasPlatforms && statusId !== currentStatus) {
      const { igdbId: updatedId, UserGamesStatus } =
        await this.userRepository.updateGameStatus(igdbId, userId, statusId)

      if (statusId === PLAYED_STATUS_ID) {
        await this.platformRepository.markSinglePlatformCompleted(
          userGame.id,
          new Date()
        )
      }

      const { stats } = await this.userRepository.findUserGameStats(
        igdbId,
        userId
      )

      return {
        igdbId: updatedId,
        userGameStatus: UserGamesStatus,
        playedCountUpdated: stats?.completions ?? 0
      }
    }

    if (currentStatus !== PLAYED_STATUS_ID && statusId === PLAYED_STATUS_ID) {
      const stats = await this.userRepository.ensureAtLeastOneCompletion(
        userId,
        igdbId
      )

      const { igdbId: updatedId, UserGamesStatus } =
        await this.userRepository.updateGameStatus(igdbId, userId, statusId)

      return {
        igdbId: updatedId,
        userGameStatus: UserGamesStatus,
        playedCountUpdated: stats?.completions ?? 0
      }
    }

    const { igdbId: updatedId, UserGamesStatus } =
      await this.userRepository.updateGameStatus(igdbId, userId, statusId)
    const { stats } = await this.userRepository.findUserGameStats(
      igdbId,
      userId
    )

    return {
      igdbId: updatedId,
      userGameStatus: UserGamesStatus,
      playedCountUpdated: stats?.completions ?? 0
    }
  }

  async update(userId: string, data: UpdateUserDTO) {
    const existing = await this.requireUser(userId)

    const user = await this.userRepository.updateUser(userId, {
      profilePicture: data.profilePicture,
      userBanner: data.userBanner,
      userName: data.userName
    })

    const replaced: string[] = []
    if (
      data.profilePicture !== undefined &&
      existing.profilePicture &&
      data.profilePicture !== existing.profilePicture
    ) {
      replaced.push(existing.profilePicture)
    }
    if (
      data.userBanner !== undefined &&
      existing.userBanner &&
      data.userBanner !== existing.userBanner
    ) {
      replaced.push(existing.userBanner)
    }
    await this.destroyOwnedImages(replaced)

    return { user }
  }

  async findUserGameStats(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const { stats } = await this.userRepository.findUserGameStats(
      igdbId,
      userId
    )

    return { playedCount: stats?.completions || 0 }
  }

  async updateUserGamePlayedCount(
    userId: string,
    igdbId: number,
    incrementValue: number
  ) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGame(igdbId, userId)
    if ((userGame?._count?.platforms ?? 0) > 0) {
      throw new ClientError(EDIT_BY_PLATFORM_MESSAGE, 400)
    }
    if (userGame?.endless && incrementValue > 0) {
      throw new ClientError(ENDLESS_COMPLETIONS_MESSAGE, 400)
    }

    const { stats } = await this.userRepository.findUserGameStats(
      igdbId,
      userId
    )
    const minimum = userGame?.UserGamesStatus?.id === PLAYED_STATUS_ID ? 1 : 0
    if ((stats?.completions ?? 0) + incrementValue < minimum) {
      throw new ClientError(
        minimum === 1
          ? 'Um jogo marcado como Jogado precisa de pelo menos uma conclusão.'
          : 'O número de vezes zerado não pode ser negativo.',
        400
      )
    }

    const userGameStats = await this.userRepository.updateUserGamePlayedCount(
      userId,
      igdbId,
      incrementValue
    )

    return { playedCount: userGameStats?.completions ?? 0 }
  }

  async findUserGameHours(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const { stats } = await this.userRepository.findUserGameHours(
      igdbId,
      userId
    )

    return { hoursPlayed: stats?.hoursPlayed ? Number(stats.hoursPlayed) : 0 }
  }

  async findUserGameCompletedAt(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGameForCompletedAt(
      igdbId,
      userId
    )
    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    return {
      completedAt: userGame.completedAt
        ? userGame.completedAt.toISOString().slice(0, 10)
        : null
    }
  }

  async updateUserGameCompletedAt(
    userId: string,
    igdbId: number,
    completedAt: string
  ) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGameForCompletedAt(
      igdbId,
      userId
    )
    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    if ((userGame._count?.platforms ?? 0) > 0) {
      throw new ClientError(EDIT_BY_PLATFORM_MESSAGE, 400)
    }

    if (userGame.userGamesStatusId !== PLAYED_STATUS_ID) {
      throw new ClientError(
        'Só é possível definir a data de finalização para jogos marcados como Jogado.',
        400
      )
    }

    const parsedDate = new Date(`${completedAt}T00:00:00.000Z`)
    if (parsedDate.getTime() > Date.now()) {
      throw new ClientError(
        'A data de finalização não pode ser no futuro.',
        400
      )
    }

    const updated = await this.userRepository.updateUserGameCompletedAt(
      igdbId,
      userId,
      parsedDate
    )

    return { completedAt: updated.completedAt!.toISOString().slice(0, 10) }
  }

  async updateUserGameHours(
    userId: string,
    igdbId: number,
    hoursPlayed: number
  ) {
    await this.requireUser(userId)

    const userGame = await this.userRepository.findUserGameStatus(
      igdbId,
      userId
    )
    if (!userGame)
      throw new ClientError('Jogo não encontrado na sua biblioteca.', 404)

    if ((userGame._count?.platforms ?? 0) > 0) {
      throw new ClientError(EDIT_BY_PLATFORM_MESSAGE, 400)
    }

    if (userGame.UserGamesStatus?.status === Status.WISHLIST) {
      throw new ClientError(
        'Não é possível definir horas jogadas para um jogo da lista de desejos.',
        400
      )
    }

    const stats = await this.userRepository.upsertUserGameHours(
      userId,
      igdbId,
      hoursPlayed
    )

    return { hoursPlayed: stats?.hoursPlayed ? Number(stats.hoursPlayed) : 0 }
  }

  async findGamesToDisplay(userId: string) {
    await this.requireUser(userId)

    const userGames = await this.userRepository.findManyGamesOfUser({ userId })

    const idsWithStatus = (status: Status) =>
      userGames.filter(ug => ug.status === status).map(ug => ug.igdbId)

    const pausedIds = idsWithStatus(Status.PAUSED)
    const backlogIds = idsWithStatus(Status.BACKLOG)
    const candidateIds = pausedIds.length > 0 ? pausedIds : backlogIds

    const ownedIds = new Set(userGames.map(ug => ug.igdbId))

    if (candidateIds.length > 0) {
      const pickedId = candidateIds[randomInt(candidateIds.length)]
      const game = await IGDBService.getGameById(pickedId)
      const slug = game ? await this.gameCacheService.findSlug(game.id) : null
      return {
        game: game
          ? {
              igdbId: game.id,
              slug,
              name: game.name,
              coverUrl: IGDBService.formatCoverUrl(game.cover?.url)
            }
          : null,
        message:
          pausedIds.length > 0
            ? 'Que tal retomar este?'
            : 'Tire a poeira desses jogos esquecidos.'
      }
    }

    const recent = await IGDBService.getRecentlyReleasedGames()
    const notOwned = recent.filter(g => !ownedIds.has(g.id))

    if (notOwned.length > 0) {
      const picked = notOwned[randomInt(notOwned.length)]
      return {
        game: {
          igdbId: picked.id,
          slug: await this.gameCacheService.findSlug(picked.id),
          name: picked.name,
          coverUrl: IGDBService.formatCoverUrl(picked.cover?.url)
        },
        message: 'Que tal adicionar um novo jogo a sua biblioteca?'
      }
    }

    return { game: null, message: 'Parabéns! Você jogou todos.' }
  }
}
