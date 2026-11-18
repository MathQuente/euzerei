import { MAX_FAVORITE_GAMES, ROULETTE_MAX_GAMES } from '../utils/library-status'
import z from 'zod'
import { isConsoleAllowed } from '../utils/platform-consoles'

export const DeleteUserResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    userName: z.string().nullable()
  })
})

export const UserParamsSchema = z.object({
  userId: z.uuid()
})

const AchievementStatsSchema = z.object({
  steam: z.object({ achievements: z.number() }).nullable(),
  xbox: z
    .object({ gamerscore: z.number(), achievements: z.number() })
    .nullable(),
  psn: z.object({ trophies: z.number(), platinum: z.number() }).nullable()
})

export const GetUserResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    userName: z.string().nullable(),
    profilePicture: z.string().nullable(),
    userBanner: z.string().nullable(),
    gamesAmount: z.number(),
    totalHoursPlayed: z.number(),
    hundredPercentCount: z.number(),
    createdAt: z.string(),
    achievementStats: AchievementStatsSchema,
    stores: z.object({
      steam: z.array(z.string()),
      playstation: z.array(z.string()),
      xbox: z.array(z.string())
    }),
    followersCount: z.number(),
    followingCount: z.number()
  })
})

export const GetMeResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    profilePicture: z.string().nullable(),
    userBanner: z.string().nullable(),
    userName: z.string().nullable(),
    email: z.string(),
    emailVerified: z.boolean(),
    hasPassword: z.boolean(),
    googleLinked: z.boolean(),
    discordLinked: z.boolean(),
    pendingEmail: z.string().nullable(),
    gamesAmount: z.number(),
    totalHoursPlayed: z.number(),
    hundredPercentCount: z.number(),
    createdAt: z.string(),
    achievementStats: AchievementStatsSchema,
    steamAccounts: z.array(
      z.object({ id: z.string(), steamId: z.string(), personaName: z.string() })
    ),
    psnAccounts: z.array(z.object({ id: z.string(), onlineId: z.string() })),
    xboxAccounts: z.array(
      z.object({
        id: z.string(),
        gamertag: z.string(),
        preferredConsole: z.string().nullable()
      })
    ),
    followersCount: z.number(),
    followingCount: z.number()
  })
})

export const QueryStringSchema = z.object({
  pageIndex: z.coerce.number().int().min(0).max(10000).default(0),
  query: z.string().max(100).optional(),
  filter: z
    .enum([
      'PLAYED',
      'PAUSED',
      'PLAYING',
      'BACKLOG',
      'WISHLIST',
      'DROPPED',
      'QUEUE'
    ])
    .optional()
    .catch(undefined),
  sortBy: z
    .enum([
      'gameName',
      'dateRelease',
      'rating',
      'dateAdded',
      'hoursPlayed',
      'completedAt'
    ])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
})

export const GetAllUsersResponseSchema = z.object({
  users: z.array(
    z.object({
      id: z.uuid(),
      userBanner: z.string().nullable(),
      userName: z.string().nullable(),
      profilePicture: z.url().nullable(),
      userGamesAmount: z.number()
    })
  )
})

export const UserGameParamsSchema = z.object({
  igdbId: z.coerce.number().int()
})

export const UserGameBodySchema = z.object({
  statusId: z.number().int().min(1).max(6)
})

export const UserGameEndlessBodySchema = z.object({
  endless: z.boolean()
})

export const UpdateUserGameEndlessResponseSchema = z.object({
  igdbId: z.number(),
  endless: z.boolean()
})

export const SetFavoritesBodySchema = z
  .object({
    igdbIds: z
      .array(z.number().int().positive().max(2147483647))
      .max(MAX_FAVORITE_GAMES, {
        message: `Escolha no máximo ${MAX_FAVORITE_GAMES} jogos favoritos.`
      })
      .refine(ids => new Set(ids).size === ids.length, {
        message: 'Um jogo não pode aparecer duas vezes.'
      }),
    mainIgdbId: z.number().int().positive().max(2147483647).nullish()
  })
  .refine(
    body => body.mainIgdbId == null || body.igdbIds.includes(body.mainIgdbId),
    { message: 'O jogo com a coroa precisa estar nos favoritos.' }
  )

export const UserGameHundredPercentBodySchema = z.object({
  hundredPercent: z.boolean()
})

export const UpdateUserGameHundredPercentResponseSchema = z.object({
  igdbId: z.number(),
  hundredPercent: z.boolean()
})

export const UserGamePlayedCountUpdateBodySchema = z.object({
  incrementValue: z.number().int().min(-1).max(1)
})

export const UserGameHoursUpdateBodySchema = z.object({
  hoursPlayed: z.number().min(0).max(9999.99)
})

export const UserGameCompletedAtUpdateBodySchema = z.object({
  completedAt: z.iso.date()
})

export const GetUserGameCompletedAtResponse = z.object({
  completedAt: z.string().nullable()
})

export const AddGameResponseSchema = z.object({
  igdbId: z.number()
})

export const RemoveGameResponseSchema = z.object({
  igdbId: z.number()
})

export const UpdateUserResponseSchema = z.object({
  user: z.object({
    profilePicture: z.string().nullable(),
    userBanner: z.string().nullable(),
    userName: z.string().nullable()
  })
})

export const GetUserGameStatusResponse = z.object({
  userGameStatus: z
    .object({
      id: z.number(),
      status: z.string()
    })
    .nullable(),
  endless: z.boolean(),
  hundredPercent: z.boolean(),
  hoursPlayed: z.number(),
  completions: z.number()
})

const UserGameEntrySchema = z.object({
  igdbId: z.number(),
  slug: z.string().nullable().optional(),
  name: z.string(),
  coverUrl: z.string().nullable(),
  platforms: z.array(z.string()).optional(),
  releaseDate: z.number().optional(),
  rating: z.number().nullable(),
  completions: z.number(),
  hoursPlayed: z.number(),
  playedOn: z.array(z.string()),
  status: z.string(),
  endless: z.boolean(),
  hundredPercent: z.boolean(),
  updatedAt: z.string().optional()
})

export const GetAllUserGamesResponseSchema = z.object({
  games: z.object({
    PLAYED: z.array(UserGameEntrySchema),
    PLAYING: z.array(UserGameEntrySchema),
    PAUSED: z.array(UserGameEntrySchema),
    BACKLOG: z.array(UserGameEntrySchema),
    WISHLIST: z.array(UserGameEntrySchema),
    DROPPED: z.array(UserGameEntrySchema)
  }),
  totalPerStatus: z.array(
    z.object({
      status: z.string(),
      totalGames: z.number()
    })
  ),
  total: z.number(),
  libraryIgdbIds: z.array(z.number()).optional()
})

const ALLOWED_IMAGE_HOSTS = new Set([
  'res.cloudinary.com',
  'lh3.googleusercontent.com',
  'cdn.discordapp.com'
])

const ImageUrlSchema = z
  .url()
  .max(2048)
  .refine(value => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(url.hostname)
  }, 'URL de imagem não permitida.')

export const UpdateUserBodySchema = z
  .object({
    userName: z.string().trim().min(1).max(30).nullable(),
    profilePicture: ImageUrlSchema.nullable(),
    userBanner: ImageUrlSchema.nullable()
  })
  .partial()

export const UpdateUserGameStatusResponseSchema = z.object({
  igdbId: z.number(),
  userGameStatus: z.object({
    id: z.number(),
    status: z.string()
  }),
  playedCountUpdated: z.number()
})

export const GetUserGameStatsResponse = z.object({
  playedCount: z.number()
})

export const GetUserGameHoursResponse = z.object({
  hoursPlayed: z.number()
})

export const GetGamesToDisplayResponseSchema = z.object({
  game: z
    .object({
      igdbId: z.number(),
      slug: z.string().nullable().optional(),
      name: z.string(),
      coverUrl: z.string().nullable()
    })
    .nullable()
    .optional(),
  message: z.string()
})

export const PlatformEnumSchema = z.enum([
  'STEAM',
  'PLAYSTATION',
  'XBOX',
  'NINTENDO',
  'EPIC',
  'GOG',
  'OTHER'
])

export const ConsoleEnumSchema = z.enum([
  'UNKNOWN',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PS5',
  'PSP',
  'PS_VITA',
  'XBOX_ORIGINAL',
  'XBOX_360',
  'XBOX_ONE',
  'XBOX_SERIES',
  'NES',
  'SNES',
  'N64',
  'GAMECUBE',
  'WII',
  'WII_U',
  'SWITCH',
  'SWITCH_2',
  'GAME_BOY',
  'GAME_BOY_COLOR',
  'GAME_BOY_ADVANCE',
  'DS',
  'N3DS',
  'PC',
  'STEAM_DECK',
  'MASTER_SYSTEM',
  'MEGA_DRIVE',
  'SEGA_CD',
  'SATURN',
  'DREAMCAST',
  'GAME_GEAR',
  'ATARI_2600',
  'ATARI_7800',
  'NEO_GEO',
  'TURBOGRAFX',
  'MOBILE',
  'ARCADE'
])

export const UserGamePlatformParamsSchema = z
  .object({
    igdbId: z.coerce.number().int(),
    platform: PlatformEnumSchema,
    console: ConsoleEnumSchema
  })
  .refine(params => isConsoleAllowed(params.platform, params.console), {
    message: 'Console inválido para esta plataforma.',
    path: ['console']
  })

export const UserGamePlatformUpdateBodySchema = z
  .object({
    hoursPlayed: z.number().min(0).max(9999.99).nullable().optional(),
    completions: z.number().int().min(0).max(999).optional(),
    completedAt: z.iso.date().nullable().optional()
  })
  .refine(body => Object.keys(body).length > 0, {
    message: 'Informe ao menos um campo para atualizar.'
  })

export const UserGamePlatformsResponseSchema = z.object({
  platforms: z.array(
    z.object({
      platform: PlatformEnumSchema,
      console: ConsoleEnumSchema,
      hoursPlayed: z.number().nullable(),
      completions: z.number(),
      completedAt: z.string().nullable(),
      accountHours: z.array(
        z.object({ accountName: z.string(), hoursPlayed: z.number() })
      )
    })
  ),
  totals: z.object({
    hoursPlayed: z.number(),
    completions: z.number(),
    completedAt: z.string().nullable()
  })
})

export const GetFavoritesResponseSchema = z.object({
  games: z.array(
    UserGameEntrySchema.extend({
      status: z.string().nullable(),
      isMain: z.boolean()
    })
  )
})

export const RouletteQueryStringSchema = z.object({
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROULETTE_MAX_GAMES)
    .default(ROULETTE_MAX_GAMES),
  exclude: z.coerce.number().int().positive().max(2147483647).optional()
})

export const GetRouletteResponseSchema = z.object({
  total: z.number(),
  games: z.array(UserGameEntrySchema)
})
