import 'dotenv/config'
import { expect } from 'vitest'

// Os testes carregam o .env real (chaves da Steam, da IGDB...), então uma
// chamada sem mock sairia de verdade: lenta, instável e com a chave fora de
// casa. Atribuição direta (e não vi.stubGlobal) para que o
// vi.unstubAllGlobals() de alguns testes volte para esta versão, não para a real.
async function blockRealFetch(input: unknown): Promise<never> {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string } | null)?.url ?? String(input))
  let where = raw
  try {
    const url = new URL(raw)
    where = `${url.host}${url.pathname}`
  } catch {
    // URL relativa ou inválida: mostra só o começo, sem query.
    where = raw.split('?')[0]
  }
  const state = expect.getState()
  throw new Error(
    `Rede real bloqueada nos testes: ${where} em ${state.testPath ?? '?'} > ${state.currentTestName ?? '?'}. Mocke o método ou use vi.stubGlobal('fetch', ...).`
  )
}

globalThis.fetch = blockRealFetch as unknown as typeof fetch
