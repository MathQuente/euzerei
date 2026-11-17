import { Status } from '../database/prisma-client'

export type UserGameSortBy =
  | 'gameName'
  | 'dateRelease'
  | 'rating'
  | 'dateAdded'
  | 'hoursPlayed'
  | 'completedAt'
export type UserGameSortOrder = 'asc' | 'desc'

export type FavoriteGameRow = Omit<PaginatedUserGameRow, 'status'> & {
  status: Status | null
  isMain: boolean
}

export type PaginatedUserGameRow = {
  igdbId: number
  status: Status
  name: string | null
  slug: string | null
  coverUrl: string | null
  platforms: string[] | null
  releaseDate: number | null
  rating: number | null
  completions: number
  hoursPlayed: number
  playedOn: string[]
  endless: boolean
  hundredPercent: boolean
}
