import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma } from '../database/db'
import { IGDBService } from '../services/igdb.service'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { mapWithConcurrency } from '../utils/map-with-concurrency'
import {
  PrecisionBackupRow,
  decidePrecision,
  formatPrecisionBackup,
  parsePrecisionBackup
} from '../utils/release-precision-backfill'
import {
  BATCH_SIZE,
  parseIntArg,
  parseStringArg,
  sleep,
  withRetry,
  writeBackupFile
} from './utils'

const CONCURRENCY = 4
const MIN_ROUND_MS = 1000
const SAMPLES = 10

// Uso:
//   npm run backfill:release-precision                    simula, não grava
//   npm run backfill:release-precision -- --apply         grava (faz backup antes)
//   npm run backfill:release-precision -- --from <id>     recomeça depois deste igdb_id
//   npm run backfill:release-precision -- --restore <arquivo> [--apply]   desfaz um --apply
// O cache só guardava a data de lançamento; a IGDB marca data incerta (ano,
// trimestre, mês, "a confirmar") com um dia qualquer, e por isso a busca, a
// biblioteca e os favoritos mostravam um 31/12 inventado. Aqui cada linha ganha
// a precisão da data que ela tem. Linhas cuja data já não é a da IGDB ficam como
// estão: rode antes o backfill:release-dates. Depois de um --restore dele, rode
// este de novo (ele zera a precisão das datas que muda).

async function restore(file: string, apply: boolean) {
  const rows = parsePrecisionBackup(readFileSync(file, 'utf8'))
  const repo = new GameCacheRepository()
  const count = await repo.restoreReleasePrecisions(rows, !apply)
  console.log(
    `${apply ? '' : '[simulação] '}${rows.length} linhas no backup, ${count} ${apply ? 'restauradas' : 'seriam restauradas'} (só onde a precisão ainda é a gravada).`
  )
  if (!apply) console.log('Rode de novo com --apply para restaurar.')
}

async function main() {
  const apply = process.argv.includes('--apply')
  const restoreFile = parseStringArg('--restore')
  if (restoreFile) {
    await restore(restoreFile, apply)
    return
  }

  const repo = new GameCacheRepository()
  let lastId = parseIntArg('--from') ?? 0
  const counts = {
    scanned: 0,
    same: 0,
    not_found: 0,
    stale_date: 0,
    unknown: 0
  }
  const changes: Array<PrecisionBackupRow & { releaseDate: number }> = []
  const byNext: Record<string, number> = {}
  const samples: string[] = []
  let round = 0

  console.log(
    `${apply ? '' : '[simulação] '}Lendo as precisões das linhas com igdb_id > ${lastId}...`
  )

  while (true) {
    round++
    const startedAt = Date.now()
    const rows = await repo.findPrecisionRowsAfter(
      lastId,
      BATCH_SIZE * CONCURRENCY
    )
    if (rows.length === 0) break

    const chunks = []
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      chunks.push(rows.slice(i, i + BATCH_SIZE))
    }
    await mapWithConcurrency(chunks, CONCURRENCY, async chunk => {
      const info = await withRetry(() =>
        IGDBService.getReleaseInfoWithDatesByIds(chunk.map(r => r.igdbId))
      )
      for (const row of chunk) {
        const decision = decidePrecision(row, info.get(row.igdbId))
        counts.scanned++
        if (decision.kind === 'no_date') continue
        if (decision.kind !== 'change') {
          counts[decision.kind]++
          continue
        }
        changes.push({
          igdbId: row.igdbId,
          previous: row.releaseDatePrecision,
          next: decision.next,
          releaseDate: row.releaseDate as number
        })
        byNext[decision.next] = (byNext[decision.next] ?? 0) + 1
        if (samples.length < SAMPLES) {
          samples.push(
            `  ${row.igdbId}: ${row.releaseDatePrecision ?? 'NULL'} -> ${decision.next} (data ${new Date((row.releaseDate ?? 0) * 1000).toISOString().slice(0, 10)})`
          )
        }
      }
    })

    lastId = rows[rows.length - 1].igdbId
    process.stdout.write(
      `\rRodada ${round} | lidas: ${counts.scanned} | a mudar: ${changes.length} | último id: ${lastId}`
    )
    const elapsed = Date.now() - startedAt
    if (elapsed < MIN_ROUND_MS) await sleep(MIN_ROUND_MS - elapsed)
  }

  console.log(`\n\n${counts.scanned} linhas lidas:`)
  console.log(`  ${changes.length} a mudar  ${JSON.stringify(byNext)}`)
  console.log(`  ${counts.same} já certas`)
  console.log(
    `  ${counts.stale_date} com data diferente da IGDB (ficam como estão; rode o backfill:release-dates)`
  )
  console.log(`  ${counts.unknown} sem date_format na IGDB (ficam como estão)`)
  console.log(`  ${counts.not_found} que a IGDB não devolveu`)
  console.log('  (linhas sem data não são consultadas)')
  for (const sample of samples) console.log(sample)

  if (changes.length === 0) {
    console.log('\nNada a fazer.')
    return
  }
  if (!apply) {
    console.log(
      `\n${changes.length} linhas mudariam. Rode com --apply para gravar.`
    )
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = `backfill-release-precision-${stamp}.csv`
  writeBackupFile(backupFile, `${formatPrecisionBackup(changes)}\n`)
  console.log(`\nBackup gravado: ${backupFile} (${changes.length} linhas).`)

  let written = 0
  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    written += await repo.updateReleasePrecisions(
      changes.slice(i, i + BATCH_SIZE).map(c => ({
        igdbId: c.igdbId,
        precision: c.next,
        releaseDate: c.releaseDate
      }))
    )
  }
  console.log(`${written} linhas atualizadas.`)
  console.log(
    `Para desfazer: npm run backfill:release-precision -- --restore ${backupFile} --apply`
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
