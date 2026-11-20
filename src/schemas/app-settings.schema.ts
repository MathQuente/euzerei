import { z } from 'zod'
import { TERMS_VERSION } from '../utils/terms'

const syncTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const APP_SETTING_SCHEMAS = {
  signupsOpen: z.boolean(),
  requireVerifiedEmail: z.boolean(),
  termsVersion: z.string().trim().min(1).max(20),
  importsPerUserPerHour: z.number().int().min(1).max(60),
  importJobTimeoutSeconds: z.number().int().min(10).max(900),
  importAutoRetry: z.boolean(),
  popularSyncEnabled: z.boolean(),
  popularSyncTime: syncTime,
  igdbQuotaWarnPercent: z.number().int().min(1).max(100)
} as const

export type AppSettingKey = keyof typeof APP_SETTING_SCHEMAS

export type AppSettings = {
  [K in AppSettingKey]: z.infer<(typeof APP_SETTING_SCHEMAS)[K]>
}

export const APP_SETTING_DEFAULTS: AppSettings = {
  signupsOpen: true,
  requireVerifiedEmail: true,
  termsVersion: TERMS_VERSION,
  importsPerUserPerHour: 5,
  importJobTimeoutSeconds: 120,
  importAutoRetry: true,
  popularSyncEnabled: true,
  popularSyncTime: '03:00',
  igdbQuotaWarnPercent: 80
}

export const APP_SETTING_KEYS = Object.keys(
  APP_SETTING_SCHEMAS
) as AppSettingKey[]

export const UpdateAppSettingsBodySchema = z
  .object(APP_SETTING_SCHEMAS)
  .partial()
  .strict()
  .refine(body => Object.keys(body).length > 0, {
    message: 'Informe ao menos uma configuração.'
  })
