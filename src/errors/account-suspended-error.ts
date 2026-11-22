import { ClientError } from './client-error'

export const SUSPENDED_ACCOUNT_MESSAGE =
  'Esta conta está suspensa. Fale com o suporte.'

/** 403 próprio: o callback de OAuth o diferencia de "e-mail não verificado" (que também é 403). */
export class AccountSuspendedError extends ClientError {
  constructor() {
    super(SUSPENDED_ACCOUNT_MESSAGE, 403)
  }
}
