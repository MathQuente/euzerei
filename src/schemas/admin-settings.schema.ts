import { z } from 'zod'
import { APP_SETTING_SCHEMAS } from './app-settings.schema'

export const AdminUpdateSettingsBodySchema = z
  .object(APP_SETTING_SCHEMAS)
  .omit({ termsVersion: true })
  .partial()
  .strict()
  .refine(body => Object.keys(body).length > 0, {
    message: 'Informe ao menos uma configuração.'
  })
