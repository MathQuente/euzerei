import { describe, it, expect } from 'vitest'
import { pidRunsScript } from './process-identity'

const own = process.pid

describe('pidRunsScript', () => {
  it('pid que não existe: falso', () => {
    expect(pidRunsScript(2 ** 22 + 12345, 'backfill-hypes', () => null)).toBe(
      false
    )
  })

  it('pid vivo que é outro processo (pid reaproveitado): falso, mesmo existindo', () => {
    expect(
      pidRunsScript(
        own,
        'backfill-hypes',
        () => ['node', '/app/dist/index.js'].join('\0') + '\0'
      )
    ).toBe(false)
    expect(
      pidRunsScript(own, 'backfill-hypes', () =>
        ['sh', '-c', 'npm start'].join('\0')
      )
    ).toBe(false)
  })

  it('pid vivo que roda o script do job (js ou ts): verdadeiro', () => {
    expect(
      pidRunsScript(own, 'backfill-hypes', () =>
        ['node', '/app/dist/scripts/backfill-hypes.js', '--apply'].join('\0')
      )
    ).toBe(true)
    expect(
      pidRunsScript(own, 'backfill-hypes', () =>
        [
          'node',
          '--import',
          'file:///x/tsx/loader.mjs',
          '/app/src/scripts/backfill-hypes.ts'
        ].join('\0')
      )
    ).toBe(true)
  })

  it('script parecido mas de outro job não conta', () => {
    expect(
      pidRunsScript(own, 'backfill-hypes', () =>
        ['node', '/app/dist/scripts/backfill-slugs.js'].join('\0')
      )
    ).toBe(false)
  })

  it('sem /proc só dá para saber que está vivo', () => {
    expect(pidRunsScript(own, 'backfill-hypes', () => null)).toBe(true)
  })
})
