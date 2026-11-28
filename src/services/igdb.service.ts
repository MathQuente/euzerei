import { IGDBRequestError } from '../errors/igdb-request-error'
import { IGDBGame } from '../types/igdb'
import { displayName, overriddenIgdbName } from '../utils/game-display-names'
import { fetchWithTimeout } from '../utils/fetch-with-timeout'
import { GAME_STATUS, isHiddenFromCatalog } from '../utils/game-status'
import { releaseDatePrecision } from '../utils/release-precision'
import { MIN_HYPES, MIN_TOTAL_RATING_COUNT } from '../utils/catalog-popularity'

const EROTIC_THEME_ID = 42

// Classics and story-driven works that IGDB tags Erotic; each id approved by hand.
export const EROTIC_EXCEPTION_IDS = [
  2906, 2908, 2910, 2911, 2912, 2913, 2914, 2915, 3826, 4251, 9648, 10679,
  12328, 22493, 46980, 63998, 65289, 81729, 102087, 136548, 138756, 172667
]
const EROTIC_EXCEPTION_LIST = EROTIC_EXCEPTION_IDS.join(',')
const EXCLUDE_EROTIC = `(themes != (${EROTIC_THEME_ID}) | id = (${EROTIC_EXCEPTION_LIST}))`

const CACHE_FIELDS =
  'id,name,alternative_names.name,summary,cover.url,genres.name,platforms.name,game_modes.name,first_release_date,release_dates.date,release_dates.date_format,hypes,total_rating_count,category,game_type,parent_game,game_status'

// IGDB registers an edition or version ("GTA VI: Ultimate Edition") as another
// game with the same date and a version_parent. Used only by coming soon: in
// the released list the same filter would also drop remasters and bundles that
// carry a version_parent (measured: 5 and 113 of 177), and nothing there
// duplicates today. DLCs and expansions use parent_game and still pass.
const EXCLUDE_EDITIONS = 'version_parent = null'

export class IGDBService {
  private static accessToken: string | null = null
  private static tokenExpiresAt: number = 0

  private static async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const response = await fetchWithTimeout(
      `https://id.twitch.tv/oauth2/token?client_id=${process.env.IGDB_CLIENT_ID}&client_secret=${process.env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
      { method: 'POST' }
    )

    const data = (await response.json()) as {
      access_token: string
      expires_in: number
    }

    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000

    return this.accessToken
  }

  private static async countRequest(
    endpoint: string,
    body: string
  ): Promise<number> {
    const token = await this.getAccessToken()
    const response = await fetchWithTimeout(
      `https://api.igdb.com/v4/${endpoint}/count`,
      {
        method: 'POST',
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID!,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain'
        },
        body
      }
    )
    const data = (await response.json()) as { count?: number }

    if (!response.ok || 'title' in data) {
      console.error('[IGDB] count request failed', {
        status: response.status,
        data
      })
      throw new IGDBRequestError('IGDB count request failed', data)
    }

    return data.count ?? 0
  }

  private static async request<T>(endpoint: string, body: string): Promise<T> {
    const token = await this.getAccessToken()

    const response = await fetchWithTimeout(
      `https://api.igdb.com/v4/${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID!,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain'
        },
        body
      }
    )

    const data = await response.json()
    if (
      !response.ok ||
      !Array.isArray(data) ||
      (data.length > 0 && 'title' in data[0])
    ) {
      console.error('[IGDB] request failed', {
        status: response.status,
        data
      })
      throw new IGDBRequestError('[IGDB] request failed', data)
    }

    return data as T
  }

  static formatCoverUrl(url: string | undefined): string | null {
    if (!url) return null
    return `https:${url.replace('t_thumb', 't_cover_big')}`
  }

  static formatScreenshotUrl(imageId: string, size: string): string {
    return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`
  }

  static readonly INT4_MAX = 2_147_483_647
  static readonly INT4_MIN = -2_147_483_648

  static getParentGameId(g: IGDBGame): number | null {
    return typeof g.parent_game === 'object'
      ? (g.parent_game?.id ?? null)
      : (g.parent_game ?? null)
  }

  static toCacheReleaseDate(epoch: number | null | undefined): number | null {
    return typeof epoch === 'number' &&
      epoch !== 0 &&
      epoch <= this.INT4_MAX &&
      epoch >= this.INT4_MIN
      ? epoch
      : null
  }

  static getGameType(g: Pick<IGDBGame, 'game_type' | 'category'>): number {
    return g.game_type ?? g.category ?? -1
  }

  static joinAlternativeNames(
    names: { name: string }[] | undefined,
    igdbId?: number
  ) {
    const original = igdbId === undefined ? null : overriddenIgdbName(igdbId)
    const all = [
      ...(original ? [original] : []),
      ...(names ?? []).map(n => n.name)
    ]
    const unique = [...new Set(all.map(n => n.trim()))].filter(Boolean)
    return unique.length > 0 ? unique.join(' | ') : null
  }

  static async getAlternativeNamesByIds(
    ids: number[]
  ): Promise<Map<number, string | null>> {
    const result = new Map<number, string | null>()
    if (ids.length === 0) return result
    const rows = await this.request<
      { id: number; alternative_names?: { name: string }[] }[]
    >(
      'games',
      `where id = (${ids.join(',')}); fields id,alternative_names.name; limit ${Math.min(ids.length, 500)};`
    )
    for (const row of rows) {
      result.set(
        row.id,
        this.joinAlternativeNames(row.alternative_names, row.id)
      )
    }
    return result
  }

  static toGameCacheInput(g: IGDBGame) {
    const releaseDate =
      this.toCacheReleaseDate(g.first_release_date) ?? undefined
    return {
      igdbId: g.id,
      name: displayName(g.id, g.name),
      alternativeNames: this.joinAlternativeNames(g.alternative_names, g.id),
      coverUrl: this.formatCoverUrl(g.cover?.url),
      summary: g.summary,
      genres: g.genres?.map(x => x.name) ?? [],
      platforms: g.platforms?.map(x => x.name) ?? [],
      releaseDate,
      releaseDatePrecision: releaseDatePrecision(releaseDate, g.release_dates),
      hypes: g.hypes ?? 0,
      totalRatingCount: g.total_rating_count ?? 0,
      category: this.getGameType(g),
      parentGameId: this.getParentGameId(g),
      gameModes: this.getGameModeIds(g),
      gameStatus: g.game_status ?? null
    }
  }

  static readonly SINGLE_PLAYER_MODE = 1
  static readonly COOP_MODE = 3
  static readonly ALWAYS_ENDLESS_MODES = [5, 6]

  static getGameModeIds(g: IGDBGame): number[] {
    return (
      g.game_modes
        ?.map(m => m.id)
        .filter((id): id is number => typeof id === 'number') ?? []
    )
  }

  private static readonly ENDLESS_FRANCHISE_PATTERNS = [
    /^EA Sports FC \d{2}\b/i,
    /^(EA Sports )?FIFA (1[5-9]|2[0-3])\b/i,
    /^(EA Sports )?NBA 2K(1[5-9]|[2-9]\d)\b/i,
    /^(EA Sports )?Madden NFL (1[6-9]|[2-8]\d)\b/i,
    /^(EA Sports )?NHL (1[6-9]|[2-8]\d)\b/i
  ]

  static isEndlessFranchise(name: string): boolean {
    if (/\bbundle\b/i.test(name)) return false
    return this.ENDLESS_FRANCHISE_PATTERNS.some(pattern => pattern.test(name))
  }

  static suggestsEndless(game: { gameModes: number[]; name: string }): boolean {
    if (this.isEndlessFranchise(game.name)) return true
    const { gameModes } = game
    if (gameModes.length === 0) return false
    if (gameModes.some(m => this.ALWAYS_ENDLESS_MODES.includes(m))) return true
    return (
      !gameModes.includes(this.SINGLE_PLAYER_MODE) &&
      !gameModes.includes(this.COOP_MODE)
    )
  }

  static suggestsEndlessForGame(g: IGDBGame): boolean {
    return this.suggestsEndless({
      gameModes: this.getGameModeIds(g),
      name: g.name
    })
  }

  static readonly MIN_HYPES = MIN_HYPES
  static readonly MIN_TOTAL_RATING_COUNT = MIN_TOTAL_RATING_COUNT

  static getReleaseCutoffEpoch(): number {
    const [year, month, day] = new Date()
      .toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' })
      .split('-')
      .map(Number)
    return Math.floor(Date.UTC(year, month - 1, day + 1) / 1000)
  }

  static async getGameById(igdbId: number): Promise<IGDBGame | null> {
    const results = await this.request<IGDBGame[]>(
      'games',
      `where id = ${igdbId}; fields id,name,alternative_names.name,summary,cover.url,genres.name,platforms.name,game_modes.name,first_release_date,category,game_type,parent_game.id,parent_game.name,parent_game.cover.url,parent_game.platforms.name,rating,follows,similar_games,game_status,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,release_dates.date,release_dates.date_format,release_dates.platform.name,screenshots.image_id,screenshots.width,screenshots.height,videos.video_id,videos.name,external_games.external_game_source,websites.type; limit 1;`
    )
    return results[0] ?? null
  }

  static readonly E_READER_PLATFORM_ID = 510
  static readonly PORT_GAME_TYPE = 11
  static readonly PACK_GAME_TYPE = 13

  static async getRelatedGames(igdbId: number): Promise<IGDBGame[]> {
    const games = await this.request<IGDBGame[]>(
      'games',
      `where parent_game = ${igdbId} & game_type != (5,12) & (cover != null | game_type != ${this.PACK_GAME_TYPE}) & (platforms != (${this.E_READER_PLATFORM_ID}) | game_type = ${this.PORT_GAME_TYPE}); fields id,name,cover.url,category,game_type,parent_game,first_release_date,rating,game_status; sort first_release_date asc; limit 50;`
    )

    return games.filter(
      g =>
        !/\bbundle\b/i.test(g.name) &&
        !isHiddenFromCatalog(g.game_status, g.first_release_date)
    )
  }

  static async getGamesByIds(ids: number[]): Promise<IGDBGame[]> {
    if (ids.length === 0) return []
    return this.request(
      'games',
      `where id = (${ids.join(',')}); fields id,name,summary,cover.url,genres.name,themes.name,platforms.name,game_modes.name,first_release_date,release_dates.date,release_dates.date_format,category,game_type,parent_game,rating,follows,game_status; limit ${Math.min(ids.length, 500)};`
    )
  }

  static readonly STEAM_EXTERNAL_GAME_SOURCE = 1
  static readonly PSN_EXTERNAL_GAME_SOURCE = 36
  static readonly XBOX_EXTERNAL_GAME_SOURCE = 11
  static readonly XBOX_SEARCH_PLATFORM_IDS = [11, 12, 49, 169, 6]
  private static readonly EXTERNAL_GAMES_BATCH_SIZE = 500
  private static readonly EXTERNAL_GAMES_PAGE_SIZE = 500

  private static async fetchExternalGames(
    uids: string[],
    source: number
  ): Promise<{ uid: string; game: number }[]> {
    const rows: { uid: string; game: number }[] = []
    for (let offset = 0; ; offset += this.EXTERNAL_GAMES_PAGE_SIZE) {
      const page = await this.request<{ uid: string; game: number }[]>(
        'external_games',
        `where uid = (${uids.map(id => `"${id}"`).join(',')}) & external_game_source = ${source}; fields uid,game; sort id asc; limit ${this.EXTERNAL_GAMES_PAGE_SIZE}; offset ${offset};`
      )
      rows.push(...page)
      if (page.length < this.EXTERNAL_GAMES_PAGE_SIZE) return rows
    }
  }

  static async getGamesByExternalIds(
    uids: string[],
    source: number
  ): Promise<{ uid: string; game: IGDBGame }[]> {
    if (uids.length === 0) return []

    const chunks: string[][] = []
    for (let i = 0; i < uids.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      chunks.push(uids.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE))
    }

    const externalGamesResults = await Promise.all(
      chunks.map(chunk => this.fetchExternalGames(chunk, source))
    )

    const uidToIgdbId = new Map<string, number>()
    for (const row of externalGamesResults.flat()) {
      if (!uidToIgdbId.has(row.uid)) uidToIgdbId.set(row.uid, row.game)
    }

    const igdbIds = [...new Set(uidToIgdbId.values())]
    const igdbIdChunks: number[][] = []
    for (let i = 0; i < igdbIds.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      igdbIdChunks.push(igdbIds.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE))
    }
    const games = (
      await Promise.all(igdbIdChunks.map(chunk => this.getGamesByIds(chunk)))
    ).flat()
    const gamesById = new Map(games.map(g => [g.id, g]))

    const results: { uid: string; game: IGDBGame }[] = []
    for (const [uid, igdbId] of uidToIgdbId) {
      const game = gamesById.get(igdbId)
      if (game) results.push({ uid, game })
    }

    return results
  }

  static async searchGamesByName(
    name: string,
    platformIds: number[]
  ): Promise<IGDBGame[]> {
    const term = name
      .replace(/[™®©"\\;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!term) return []
    return this.request(
      'games',
      `search "${term}"; fields id,name,alternative_names.name,summary,cover.url,genres.name,platforms.name,game_modes.name,first_release_date,release_dates.date,release_dates.date_format,category,game_type,parent_game,rating,follows,total_rating_count,game_status; where platforms = (${platformIds.join(',')}); limit 10;`
    )
  }

  static async getGamesBySteamAppIds(
    appIds: number[]
  ): Promise<{ appId: number; game: IGDBGame }[]> {
    const results = await this.getGamesByExternalIds(
      appIds.map(String),
      this.STEAM_EXTERNAL_GAME_SOURCE
    )
    return results.map(({ uid, game }) => ({ appId: Number(uid), game }))
  }

  static async getRecentlyReleasedGames(
    limit = 6,
    cutoff = this.getReleaseCutoffEpoch()
  ): Promise<IGDBGame[]> {
    return this.request<IGDBGame[]>(
      'games',
      `fields id,name,cover.url,rating,platforms.name,first_release_date,category,game_type,parent_game; where first_release_date < ${cutoff} & first_release_date != null & cover != null & ${EXCLUDE_EROTIC} & total_rating_count >= ${this.MIN_TOTAL_RATING_COUNT}; sort first_release_date desc; limit ${limit};`
    )
  }

  static async fetchForSync(
    lastId: number,
    limit: number
  ): Promise<IGDBGame[]> {
    return this.request(
      'games',
      `fields ${CACHE_FIELDS}; where id > ${lastId} & cover != null & ${EXCLUDE_EROTIC}; sort id asc; limit ${limit};`
    )
  }

  static async fetchMissingReleasedContent(
    lastId: number,
    maxId: number,
    limit: number
  ): Promise<IGDBGame[]> {
    return this.request(
      'games',
      `fields ${CACHE_FIELDS}; where id > ${lastId} & id <= ${maxId} & cover != null & ${EXCLUDE_EROTIC} & parent_game != null; sort id asc; limit ${limit};`
    )
  }

  static async fetchPopularForSync(
    lastId: number,
    limit: number
  ): Promise<IGDBGame[]> {
    return this.request(
      'games',
      `fields ${CACHE_FIELDS}; where id > ${lastId} & cover != null & ${EXCLUDE_EROTIC} & (total_rating_count >= ${MIN_TOTAL_RATING_COUNT} | hypes >= ${MIN_HYPES}); sort id asc; limit ${limit};`
    )
  }

  static async getPopularityByIds(
    ids: number[]
  ): Promise<Map<number, { hypes: number; totalRatingCount: number }>> {
    const unique = [...new Set(ids)]
    const popularity = new Map<
      number,
      { hypes: number; totalRatingCount: number }
    >()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<
        { id: number; hypes?: number; total_rating_count?: number }[]
      >(
        'games',
        `where id = (${chunk.join(',')}); fields id,hypes,total_rating_count; limit ${chunk.length};`
      )
      for (const row of results) {
        popularity.set(row.id, {
          hypes: row.hypes ?? 0,
          totalRatingCount: row.total_rating_count ?? 0
        })
      }
    }

    return popularity
  }

  static async fetchEroticIds(
    lastId: number,
    limit: number
  ): Promise<number[]> {
    const games = await this.request<{ id: number }[]>(
      'games',
      `fields id; where id > ${lastId} & themes = (${EROTIC_THEME_ID}) & id != (${EROTIC_EXCEPTION_LIST}); sort id asc; limit ${limit};`
    )
    return games.map(game => game.id)
  }

  static async getHypesByIds(ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map()
    const results = await this.request<{ id: number; hypes?: number }[]>(
      'games',
      `where id = (${ids.join(',')}); fields id,hypes; limit ${Math.min(ids.length, 500)};`
    )
    return new Map(results.map(r => [r.id, r.hypes ?? 0]))
  }

  static async getTimeToBeatByGameIds(
    ids: number[]
  ): Promise<Map<number, number>> {
    const unique = [...new Set(ids)]
    const timesByGame = new Map<number, number>()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<
        { game_id: number; normally?: number }[]
      >(
        'game_time_to_beats',
        `where game_id = (${chunk.join(',')}); fields game_id,normally; limit ${chunk.length};`
      )
      for (const row of results) {
        if (row.normally && row.normally > 0) {
          timesByGame.set(row.game_id, row.normally)
        }
      }
    }

    return timesByGame
  }

  static readonly EXPANSION_GAME_TYPE = 2

  static async getGameTypesByIds(ids: number[]): Promise<Map<number, number>> {
    const unique = [...new Set(ids)]
    const typesByGame = new Map<number, number>()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<{ id: number; game_type?: number }[]>(
        'games',
        `where id = (${chunk.join(',')}); fields id,game_type; limit ${chunk.length};`
      )
      for (const row of results) {
        if (typeof row.game_type === 'number') {
          typesByGame.set(row.id, row.game_type)
        }
      }
    }

    return typesByGame
  }

  static async getReleaseInfoByIds(
    ids: number[]
  ): Promise<
    Map<number, { releaseDate: number | null; gameStatus: number | null }>
  > {
    const unique = [...new Set(ids)]
    const info = new Map<
      number,
      { releaseDate: number | null; gameStatus: number | null }
    >()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<
        { id: number; first_release_date?: number; game_status?: number }[]
      >(
        'games',
        `where id = (${chunk.join(',')}); fields id,first_release_date,game_status; limit ${chunk.length};`
      )
      for (const row of results) {
        info.set(row.id, {
          releaseDate: this.toCacheReleaseDate(row.first_release_date),
          gameStatus:
            typeof row.game_status === 'number' ? row.game_status : null
        })
      }
    }

    return info
  }

  /** Data e `release_dates` de cada jogo, para o backfill de precisão do cache. */
  static async getReleaseInfoWithDatesByIds(ids: number[]): Promise<
    Map<
      number,
      {
        releaseDate: number | null
        releaseDates?: { date?: number; date_format?: number }[]
      }
    >
  > {
    const unique = [...new Set(ids)]
    const info = new Map<
      number,
      {
        releaseDate: number | null
        releaseDates?: { date?: number; date_format?: number }[]
      }
    >()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<IGDBGame[]>(
        'games',
        `where id = (${chunk.join(',')}); fields id,first_release_date,release_dates.date,release_dates.date_format; limit ${chunk.length};`
      )
      for (const row of results) {
        info.set(row.id, {
          releaseDate: this.toCacheReleaseDate(row.first_release_date),
          releaseDates: row.release_dates
        })
      }
    }

    return info
  }

  static async getCoverUrlsByIds(
    ids: number[]
  ): Promise<Map<number, string | null>> {
    const unique = [...new Set(ids)]
    const covers = new Map<number, string | null>()

    for (let i = 0; i < unique.length; i += this.EXTERNAL_GAMES_BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.EXTERNAL_GAMES_BATCH_SIZE)
      const results = await this.request<
        { id: number; cover?: { url?: string } }[]
      >(
        'games',
        `where id = (${chunk.join(',')}); fields id,cover.url; limit ${chunk.length};`
      )
      for (const row of results) {
        covers.set(row.id, this.formatCoverUrl(row.cover?.url))
      }
    }

    return covers
  }

  static async getTotalRatingCountsByIds(
    ids: number[]
  ): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map()
    const results = await this.request<
      { id: number; total_rating_count?: number }[]
    >(
      'games',
      `where id = (${ids.join(',')}); fields id,total_rating_count; limit ${Math.min(ids.length, 500)};`
    )
    return new Map(results.map(r => [r.id, r.total_rating_count ?? 0]))
  }

  static async getGameModesByIds(
    ids: number[]
  ): Promise<Map<number, number[]>> {
    if (ids.length === 0) return new Map()
    const results = await this.request<{ id: number; game_modes?: number[] }[]>(
      'games',
      `where id = (${ids.join(',')}); fields id,game_modes; limit ${Math.min(ids.length, 500)};`
    )
    return new Map(results.map(r => [r.id, r.game_modes ?? []]))
  }

  static async getGameStatusByIds(
    ids: number[]
  ): Promise<Map<number, number | null>> {
    if (ids.length === 0) return new Map()
    const results = await this.request<{ id: number; game_status?: number }[]>(
      'games',
      `where id = (${ids.join(',')}); fields id,game_status; limit ${Math.min(ids.length, 500)};`
    )
    return new Map(results.map(r => [r.id, r.game_status ?? null]))
  }

  static async getCategoryAndParentByIds(
    ids: number[]
  ): Promise<Map<number, { category: number; parentGameId: number | null }>> {
    if (ids.length === 0) return new Map()
    const results = await this.request<
      {
        id: number
        category?: number
        game_type?: number
        parent_game?: number
      }[]
    >(
      'games',
      `where id = (${ids.join(',')}); fields id,category,game_type,parent_game; limit ${Math.min(ids.length, 500)};`
    )
    return new Map(
      results.map(r => [
        r.id,
        { category: this.getGameType(r), parentGameId: r.parent_game ?? null }
      ])
    )
  }

  static async getComingSoonGames(
    limit = 20,
    pageIndex = 0,
    cutoff = this.getReleaseCutoffEpoch()
  ): Promise<{ games: IGDBGame[]; total: number }> {
    const where = `where first_release_date >= ${cutoff} & cover != null & ${EXCLUDE_EROTIC} & ${EXCLUDE_EDITIONS} & hypes >= ${this.MIN_HYPES} & game_status != ${GAME_STATUS.RUMORED}`
    const [games, rawTotal] = await Promise.all([
      this.request<IGDBGame[]>(
        'games',
        `fields id,name,cover.url,platforms.name,first_release_date,release_dates.date,release_dates.date_format,category,game_type,parent_game; ${where}; sort first_release_date asc; limit ${limit}; offset ${pageIndex * limit};`
      ),
      this.countRequest('games', `${where};`)
    ])
    return { games, total: Math.min(rawTotal, 10000) }
  }

  static async getSimilarGames(igdbId: number): Promise<IGDBGame[]> {
    const results = await this.request<IGDBGame[]>(
      'games',
      `where id = ${igdbId}; fields similar_games; limit 1;`
    )

    const similarIds = results[0]?.similar_games
    if (!similarIds || similarIds.length === 0) return []

    return this.request(
      'games',
      `where id = (${similarIds.slice(0, 12).join(',')}); fields id,name,cover.url,rating,platforms.name,category,game_type,parent_game,first_release_date,game_status; limit 12;`
    )
  }
}
