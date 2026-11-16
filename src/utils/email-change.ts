export const EMAIL_CHANGE_TTL_SECONDS = 24 * 60 * 60

export const emailChangeKey = (tokenHash: string) => `email-change:${tokenHash}`

export const emailChangeCurrentKey = (userId: string) =>
  `email-change-current:${userId}`

export interface PendingEmailChange {
  tokenHash: string
  newEmail: string
}

export function parsePendingEmailChange(
  value: unknown
): PendingEmailChange | null {
  if (typeof value !== 'object' || value === null) return null
  const { tokenHash, newEmail } = value as Record<string, unknown>
  if (typeof tokenHash !== 'string' || typeof newEmail !== 'string') {
    return null
  }
  return { tokenHash, newEmail }
}
