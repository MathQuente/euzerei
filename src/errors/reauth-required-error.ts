export class ReauthRequiredError extends Error {
  constructor() {
    super('Entre novamente para confirmar esta ação.')
  }
}
