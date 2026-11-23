import { describe, it, expect, vi } from 'vitest'
import { LineSplitter, LOG_LINE_MAX, redactLogLine } from './redact-log'

describe('redactLogLine', () => {
  it.each([
    [
      'https://id.twitch.tv/oauth2/token?client_id=abc123&client_secret=s3cr3t&grant_type=client_credentials',
      'client_secret=…'
    ],
    ['falhou com access_token=eyJabc.def', 'access_token=…'],
    ['Authorization: Bearer eyJhbGciOi.payload.sig', 'Bearer …'],
    ['postgresql://lib:hunter2@localhost:5433/lib_db', '//…@']
  ])('esconde o segredo em %s', (line, expected) => {
    const out = redactLogLine(line)
    expect(out).toContain(expected)
    for (const secret of [
      's3cr3t',
      'abc123',
      'eyJabc',
      'eyJhbGciOi',
      'hunter2'
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  it('deixa passar linha comum e corta as muito longas', () => {
    expect(
      redactLogLine('  Round 3 | +2000 games | Total updated: 6000 ')
    ).toBe('Round 3 | +2000 games | Total updated: 6000')
    expect(redactLogLine('x'.repeat(1000))).toHaveLength(LOG_LINE_MAX)
  })
})

describe('LineSplitter', () => {
  function build() {
    const lines: string[] = []
    const progress = vi.fn()
    return {
      lines,
      progress,
      splitter: new LineSplitter(l => lines.push(l), progress)
    }
  }

  it('\\n fecha uma linha; \\r vira atualização de progresso', () => {
    const { lines, progress, splitter } = build()
    splitter.feed('Batch 1\rBatch 2\rBatch 3\nDone\n')

    expect(lines).toEqual(['Batch 3', 'Done'])
    expect(progress.mock.calls.map(c => c[0])).toEqual(['Batch 1', 'Batch 2'])
  })

  it('junta pedaços que chegam partidos e guarda o resto como progresso', () => {
    const { lines, progress, splitter } = build()
    splitter.feed('Oi, mun')
    splitter.feed('do\nAind')

    expect(lines).toEqual(['Oi, mundo'])
    expect(progress).toHaveBeenLastCalledWith('Aind')
  })

  it('no fim o resto vira linha e linhas vazias são ignoradas', () => {
    const { lines, splitter } = build()
    splitter.feed('\n\n  \nfim sem quebra')
    splitter.end()

    expect(lines).toEqual(['fim sem quebra'])
  })
})
