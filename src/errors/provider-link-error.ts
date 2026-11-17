import { ClientError } from './client-error'

export type ProviderLinkErrorCode =
  'ja_ligado' | 'ja_ligado_outra_conta' | 'email_nao_verificado'

export class ProviderLinkError extends ClientError {
  constructor(
    public readonly code: ProviderLinkErrorCode,
    message: string
  ) {
    super(message, code === 'email_nao_verificado' ? 403 : 409)
  }
}
