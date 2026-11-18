import { describe, it, expect } from 'vitest'
import { Console } from '../database/prisma-client'
import {
  DeleteUserResponseSchema,
  QueryStringSchema,
  UpdateUserBodySchema,
  UserGameBodySchema,
  UserGamePlatformParamsSchema,
  UserGameCompletedAtUpdateBodySchema,
  ConsoleEnumSchema,
  UserGamePlayedCountUpdateBodySchema,
  SetFavoritesBodySchema,
  RouletteQueryStringSchema
} from './user.schema'

describe('UpdateUserBodySchema', () => {
  it.each([
    ['a Cloudinary URL', 'https://res.cloudinary.com/demo/image/upload/a.png'],
    ['a Google avatar', 'https://lh3.googleusercontent.com/a/abc'],
    ['a Discord avatar', 'https://cdn.discordapp.com/avatars/1/a.png']
  ])('accepts %s as profile picture', (_name, profilePicture) => {
    expect(UpdateUserBodySchema.safeParse({ profilePicture }).success).toBe(
      true
    )
  })

  it.each([
    ['another host', 'https://evil.example/pixel.png'],
    ['plain http', 'http://res.cloudinary.com/demo/a.png'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a look-alike host', 'https://res.cloudinary.com.evil.example/a.png']
  ])('rejects %s as profile picture', (_name, profilePicture) => {
    expect(UpdateUserBodySchema.safeParse({ profilePicture }).success).toBe(
      false
    )
  })

  it('limits the user name length', () => {
    expect(
      UpdateUserBodySchema.safeParse({ userName: 'a'.repeat(31) }).success
    ).toBe(false)
    expect(UpdateUserBodySchema.parse({ userName: '  Ana  ' }).userName).toBe(
      'Ana'
    )
  })
})

describe('library schemas', () => {
  it('only accepts existing status ids', () => {
    expect(UserGameBodySchema.safeParse({ statusId: 3 }).success).toBe(true)
    expect(UserGameBodySchema.safeParse({ statusId: 99 }).success).toBe(false)
    expect(UserGameBodySchema.safeParse({ statusId: 1.5 }).success).toBe(false)
  })

  it('only accepts single-step played count changes', () => {
    expect(
      UserGamePlayedCountUpdateBodySchema.safeParse({ incrementValue: -1 })
        .success
    ).toBe(true)
    expect(
      UserGamePlayedCountUpdateBodySchema.safeParse({
        incrementValue: 2147483647
      }).success
    ).toBe(false)
  })

  it('rejects negative and huge page indexes', () => {
    expect(QueryStringSchema.safeParse({ pageIndex: '-1' }).success).toBe(false)
    expect(QueryStringSchema.safeParse({ pageIndex: '999999' }).success).toBe(
      false
    )
  })
})

describe('UserGamePlatformParamsSchema', () => {
  const parse = (platform: string, console: string) =>
    UserGamePlatformParamsSchema.safeParse({ igdbId: '10', platform, console })

  it('accepts a console that belongs to the platform', () => {
    expect(parse('XBOX', 'XBOX_360').success).toBe(true)
  })

  it('accepts UNKNOWN on every platform', () => {
    for (const platform of [
      'STEAM',
      'PLAYSTATION',
      'XBOX',
      'NINTENDO',
      'EPIC',
      'GOG',
      'OTHER'
    ]) {
      expect(parse(platform, 'UNKNOWN').success).toBe(true)
    }
  })

  it('rejects a console from another platform', () => {
    expect(parse('XBOX', 'PS5').success).toBe(false)
  })

  it('rejects a console that does not exist', () => {
    expect(parse('XBOX', 'DREAMBOX').success).toBe(false)
  })

  it('keeps the enum in sync with the Prisma enum', () => {
    expect([...ConsoleEnumSchema.options].sort()).toEqual(
      Object.values(Console).sort()
    )
  })
})

describe('DeleteUserResponseSchema', () => {
  const response = (userName: string | null) => ({
    user: { id: '3f2b8c1e-6d4a-4a39-9c1e-0b1c2d3e4f5a', userName }
  })

  it('accepts a deleted user without a name', () => {
    expect(DeleteUserResponseSchema.safeParse(response(null)).success).toBe(
      true
    )
  })

  it('accepts a deleted user with a name', () => {
    expect(DeleteUserResponseSchema.safeParse(response('ana')).success).toBe(
      true
    )
  })
})

describe('UserGameCompletedAtUpdateBodySchema', () => {
  it.each([
    ['2024-02-29', true],
    ['2024-02-30', false],
    ['2024-1-1', false],
    ['2024-01-01T00:00:00Z', false],
    ['', false]
  ])('completedAt %j is accepted: %s', (completedAt, accepted) => {
    expect(
      UserGameCompletedAtUpdateBodySchema.safeParse({ completedAt }).success
    ).toBe(accepted)
  })
})

describe('SetFavoritesBodySchema', () => {
  it('accepts a list with or without a crown', () => {
    expect(SetFavoritesBodySchema.safeParse({ igdbIds: [1, 2] }).success).toBe(
      true
    )
    expect(
      SetFavoritesBodySchema.safeParse({ igdbIds: [1, 2], mainIgdbId: 2 })
        .success
    ).toBe(true)
    expect(
      SetFavoritesBodySchema.safeParse({ igdbIds: [1], mainIgdbId: null })
        .success
    ).toBe(true)
  })

  it('refuses a crown that is not in the list', () => {
    const result = SetFavoritesBodySchema.safeParse({
      igdbIds: [1, 2],
      mainIgdbId: 3
    })
    expect(result.success).toBe(false)
  })

  it('still refuses more than four, repeated and out-of-range ids', () => {
    expect(
      SetFavoritesBodySchema.safeParse({ igdbIds: [1, 2, 3, 4, 5] }).success
    ).toBe(false)
    expect(SetFavoritesBodySchema.safeParse({ igdbIds: [1, 1] }).success).toBe(
      false
    )
    expect(
      SetFavoritesBodySchema.safeParse({ igdbIds: [3000000000] }).success
    ).toBe(false)
  })
})

describe('RouletteQueryStringSchema', () => {
  it('uses 24 games when no count is given and exclude is optional', () => {
    expect(RouletteQueryStringSchema.parse({})).toEqual({ count: 24 })
  })

  it('reads count and exclude sent as query strings', () => {
    expect(
      RouletteQueryStringSchema.parse({ count: '10', exclude: '252647' })
    ).toEqual({ count: 10, exclude: 252647 })
  })

  it('refuses a count outside 1 to 24 or not a whole number', () => {
    for (const count of ['0', '25', '-3', '2.5', 'abc']) {
      expect(RouletteQueryStringSchema.safeParse({ count }).success).toBe(false)
    }
  })

  it('refuses an exclude that is not a positive id inside the database range', () => {
    for (const exclude of ['0', '-1', 'abc', '3000000000']) {
      expect(RouletteQueryStringSchema.safeParse({ exclude }).success).toBe(
        false
      )
    }
  })
})
