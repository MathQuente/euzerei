import { describe, expect, it } from 'vitest'

describe('bloqueio de rede nos testes', () => {
  it('recusa fetch real e não mostra a query (chaves)', async () => {
    const attempt = fetch('https://example.com/x?key=SEGREDO')

    await expect(attempt).rejects.toThrow(
      /Rede real bloqueada.*example\.com\/x/
    )
    await expect(attempt).rejects.not.toThrow(/SEGREDO/)
  })

  it('recusa também localhost', async () => {
    await expect(fetch('http://localhost:3333/health')).rejects.toThrow(
      /Rede real bloqueada/
    )
  })

  it('informa o teste que tentou sair', async () => {
    await expect(fetch('https://example.com')).rejects.toThrow(
      /network-guard\.test\.ts > .*informa o teste/
    )
  })
})
