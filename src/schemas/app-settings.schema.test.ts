import { describe, it, expect } from 'vitest'
import {
  APP_SETTING_DEFAULTS,
  APP_SETTING_KEYS,
  APP_SETTING_SCHEMAS,
  UpdateAppSettingsBodySchema
} from './app-settings.schema'
import { TERMS_VERSION } from '../utils/terms'

describe('app settings defaults', () => {
  it('are valid for their own schemas, one per key', () => {
    for (const key of APP_SETTING_KEYS) {
      expect(
        APP_SETTING_SCHEMAS[key].safeParse(APP_SETTING_DEFAULTS[key]).success
      ).toBe(true)
    }
  })

  it('keep the terms version the app already uses', () => {
    expect(APP_SETTING_DEFAULTS.termsVersion).toBe(TERMS_VERSION)
  })
})

describe('UpdateAppSettingsBodySchema', () => {
  it('accepts a partial update', () => {
    expect(
      UpdateAppSettingsBodySchema.parse({
        signupsOpen: false,
        popularSyncTime: '04:30'
      })
    ).toEqual({ signupsOpen: false, popularSyncTime: '04:30' })
  })

  it('refuses an empty update', () => {
    expect(UpdateAppSettingsBodySchema.safeParse({}).success).toBe(false)
  })

  it('refuses a key that is not a setting', () => {
    expect(
      UpdateAppSettingsBodySchema.safeParse({ passwordMinLength: 4 }).success
    ).toBe(false)
  })

  it.each([
    ['importsPerUserPerHour', 0],
    ['importsPerUserPerHour', 61],
    ['importsPerUserPerHour', 2.5],
    ['importJobTimeoutSeconds', 9],
    ['importJobTimeoutSeconds', 901],
    ['igdbQuotaWarnPercent', 0],
    ['igdbQuotaWarnPercent', 101],
    ['popularSyncTime', '24:00'],
    ['popularSyncTime', '3:00'],
    ['popularSyncTime', '03:60'],
    ['termsVersion', '   '],
    ['termsVersion', 'v'.repeat(21)],
    ['signupsOpen', 'sim'],
    ['importsPerUserPerHour', '5']
  ])('refuses %s = %j', (key, value) => {
    expect(
      UpdateAppSettingsBodySchema.safeParse({ [key]: value }).success
    ).toBe(false)
  })

  it.each([
    ['importsPerUserPerHour', 1],
    ['importsPerUserPerHour', 60],
    ['importJobTimeoutSeconds', 10],
    ['importJobTimeoutSeconds', 900],
    ['igdbQuotaWarnPercent', 100],
    ['popularSyncTime', '00:00'],
    ['popularSyncTime', '23:59']
  ])('accepts the limit %s = %j', (key, value) => {
    expect(
      UpdateAppSettingsBodySchema.safeParse({ [key]: value }).success
    ).toBe(true)
  })

  it('trims the terms version', () => {
    expect(
      UpdateAppSettingsBodySchema.parse({ termsVersion: '  v4 ' })
    ).toEqual({
      termsVersion: 'v4'
    })
  })
})
