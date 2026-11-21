import { ClientError } from '../errors/client-error'
import { TimeoutError, withTimeout } from './with-timeout'

export const READ_TIMEOUT_MS = 5_000

export async function withReadLimit<T>(
  read: () => Promise<T>,
  message: string
): Promise<T> {
  try {
    return await withTimeout(read(), READ_TIMEOUT_MS, message)
  } catch (error) {
    if (error instanceof TimeoutError) throw new ClientError(message, 503)
    throw error
  }
}
