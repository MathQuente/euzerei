import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma } from '../database/db'
import { IGDBService } from '../services/igdb.service'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import {
  PopularityChangeKind,
  classifyPopularityChange
} from '../utils/popularity-change'
import {
  PopularityBackupRow,
  formatPopularityBackup,
  isInsertedRow,
  parsePopularityBackup
} from '../utils/popularity-backup'
import {
  BATCH_SIZE,
  DELAY_MS,
  parseIdsArg,
  parseIntArg,
  parseStringArg,
  sleep,
  withRetry,
  writeBackupFile
} from './utils'

const SAMPLES_PER_KIND = 10
const CACHE_PAGE_SIZE = 5000

const LABELS: Record<PopularityChangeKind, string> = {
  inserir: 'faltam no cache (inserir)',
  igual: 'iguais',
  entra_no_filtro: 'entram no filtro de popularidade',
  sai_do_filtro: 'saem do filtro de popularidade',
  so_valor: 'só o valor dos contadores muda'
}

type CacheInput = ReturnType<typeof IGDBService.toGameCacheInput>

interface Change {
  igdbId: number
  name: string
  kind: PopularityChangeKind
  writes: boolean
  previous: { hypes: number; totalRatingCount: number } | null
  next: { hypes: number; totalRatingCount: number }
  insert?: CacheInput
}

function describe(change: Change) {
  const from = change.previous
    ? `${change.previous.totalRatingCount} aval./${change.previous.hypes} exp.`
    : 'sem linha'
  const to = `${change.next.totalRatingCount} aval./${change.next.hypes} exp.`
  return `${change.igdbId} ${change.name.slice(0, 40)}: ${from} -> ${to} [${change.kind}]`
}

async function restore(
  repo: GameCacheRepository,
  file: string,
  dryRun: boolean
) {
  const rows = parsePopularityBackup(readFileSync(file, 'utf8'))
  const updates = rows.filter(
    (r): r is Exclude<PopularityBackupRow, { inserted: true }> =>
      !isInsertedRow(r)
  )
  const insertedIds = rows.filter(isInsertedRow).map(r => r.igdbId)
  const reverted = await repo.restorePopularity(updates, dryRun)
  const removal = await repo.deleteUnreferencedCacheRows(insertedIds, dryRun)
  const prefix = dryRun ? '[dry run] ' : ''
  console.log(
    `${prefix}${updates.length} atualizações no backup, ${reverted} ${dryRun ? 'seriam revertidas' : 'revertidas'} (só onde os contadores ainda são os gravados pelo sync).`
  )
  console.log(
    `${prefix}${insertedIds.length} inserções no backup, ${removal.deleted} ${dryRun ? 'seriam apagadas' : 'apagadas'} e ${removal.skipped.length} puladas por estarem na biblioteca, em nota, avaliação ou favoritos de alguém.`
  )
  if (removal.skipped.length > 0) {
    console.log(`Puladas: ${removal.skipped.slice(0, 50).join(',')}`)
  }
}

async function main() {
  const repo = new GameCacheRepository()
  const dryRun = process.argv.includes('--dry-run')
  const restoreFile = parseStringArg('--restore')

  if (restoreFile) {
    await restore(repo, restoreFile, dryRun)
    await prisma.$disconnect()
    return
  }

  const firstId = parseIntArg('--from') ?? 0
  const maxChanges = parseIntArg('--max-changes')
  const show = new Set(parseIdsArg('--show'))

  console.log(
    `${dryRun ? '[dry run] ' : ''}Conjunto popular do IGDB contra o cache (igdb_id > ${firstId}).\n`
  )

  const counts = new Map<PopularityChangeKind, number>()
  const samples = new Map<PopularityChangeKind, Change[]>()
  const changes: Change[] = []
  const shown = new Map<number, Change>()
  const upstreamIds = new Set<number>()
  let zeroed = 0
  let round = 0
  let lastId = firstId

  const record = (change: Change) => {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1)
    if (show.has(change.igdbId)) shown.set(change.igdbId, change)
    if (change.kind === 'igual') return
    const bucket = samples.get(change.kind) ?? []
    if (bucket.length < SAMPLES_PER_KIND) bucket.push(change)
    samples.set(change.kind, bucket)
    if (
      change.previous &&
      change.next.hypes === 0 &&
      change.next.totalRatingCount === 0 &&
      (change.previous.hypes > 0 || change.previous.totalRatingCount > 0)
    ) {
      zeroed++
    }
    if (change.writes) changes.push(change)
  }

  while (true) {
    round++
    const startedAt = Date.now()
    const games = await withRetry(() =>
      IGDBService.fetchPopularForSync(lastId, BATCH_SIZE)
    )
    if (games.length === 0) break

    const existing = await repo.findPopularityByIds(games.map(g => g.id))
    for (const game of games) {
      upstreamIds.add(game.id)
      const input = IGDBService.toGameCacheInput(game)
      const cache = existing.get(game.id) ?? null
      const result = classifyPopularityChange({
        cache,
        igdb: {
          hypes: input.hypes,
          totalRatingCount: input.totalRatingCount
        }
      })
      record({
        igdbId: game.id,
        name: game.name,
        kind: result.kind,
        writes: result.writes,
        previous: cache
          ? {
              hypes: cache.hypes ?? 0,
              totalRatingCount: cache.totalRatingCount ?? 0
            }
          : null,
        next: result.next,
        insert: result.kind === 'inserir' ? input : undefined
      })
    }

    lastId = games[games.length - 1].id
    process.stdout.write(
      `\rRodada ${round} | populares lidos ${upstreamIds.size} | Último ID: ${lastId}`
    )
    const elapsed = Date.now() - startedAt
    if (elapsed < DELAY_MS) await sleep(DELAY_MS - elapsed)
  }

  let revisited = 0
  let notReturned = 0
  let cacheLast = firstId
  while (true) {
    const page = await repo.findPopularIdsAfter(cacheLast, CACHE_PAGE_SIZE)
    if (page.length === 0) break
    cacheLast = page[page.length - 1]
    const missingUpstream = page.filter(id => !upstreamIds.has(id))
    if (missingUpstream.length === 0) continue

    const current = await withRetry(() =>
      IGDBService.getPopularityByIds(missingUpstream)
    )
    const existing = await repo.findPopularityByIds(missingUpstream)
    for (const id of missingUpstream) {
      const igdb = current.get(id)
      if (!igdb) {
        notReturned++
        continue
      }
      revisited++
      const cache = existing.get(id) ?? null
      const result = classifyPopularityChange({ cache, igdb })
      record({
        igdbId: id,
        name: `jogo ${id}`,
        kind: result.kind,
        writes: result.writes,
        previous: cache
          ? {
              hypes: cache.hypes ?? 0,
              totalRatingCount: cache.totalRatingCount ?? 0
            }
          : null,
        next: result.next
      })
    }
  }

  changes.sort((a, b) => a.igdbId - b.igdbId)
  console.log(
    `\n\nPopulares no IGDB: ${upstreamIds.size} | visíveis do cache fora do conjunto, reconferidos: ${revisited} | não retornados: ${notReturned}`
  )
  for (const [kind, label] of Object.entries(LABELS)) {
    console.log(
      `  ${String(counts.get(kind as PopularityChangeKind) ?? 0).padStart(6)}  ${label}`
    )
  }
  console.log(
    `\nMudanças: ${changes.length} (${changes.filter(c => c.kind === 'inserir').length} inserções, ${changes.filter(c => c.kind !== 'inserir').length} atualizações) | contadores que caem para 0: ${zeroed}`
  )

  for (const [kind, bucket] of samples) {
    console.log(`\nAmostra (${LABELS[kind]}):`)
    for (const change of bucket) console.log(`  ${describe(change)}`)
  }
  for (const id of show) {
    console.log(
      `\n--show ${id}: ${shown.get(id) ? describe(shown.get(id)!) : 'fora da seleção'}`
    )
  }

  if (dryRun) {
    console.log('\nDry run: nada foi gravado.')
    await prisma.$disconnect()
    return
  }

  const toApply =
    maxChanges === undefined ? changes : changes.slice(0, maxChanges)
  if (toApply.length === 0) {
    console.log('\nNada a gravar.')
    await prisma.$disconnect()
    return
  }

  const backupRows: PopularityBackupRow[] = toApply.map(change =>
    change.kind === 'inserir' || change.previous === null
      ? { igdbId: change.igdbId, inserted: true as const }
      : { igdbId: change.igdbId, previous: change.previous, next: change.next }
  )
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/:/g, '-')
  const backupFile = `sync-popular-${stamp}.jsonl`
  writeBackupFile(backupFile, formatPopularityBackup(backupRows) + '\n')
  console.log(`\nBackup gravado: ${backupFile} (${backupRows.length} linhas).`)

  const inserts = toApply.filter(c => c.kind === 'inserir' && c.insert)
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    await repo.upsertMany(
      inserts.slice(i, i + BATCH_SIZE).map(c => c.insert as CacheInput)
    )
  }
  const confirmed = await repo.findPopularityByIds(inserts.map(c => c.igdbId))

  const updates = toApply.filter(c => c.kind !== 'inserir')
  let updated = 0
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    updated += await repo.updatePopularity(
      updates.slice(i, i + BATCH_SIZE).map(c => ({
        igdbId: c.igdbId,
        hypes: c.next.hypes,
        totalRatingCount: c.next.totalRatingCount
      }))
    )
  }

  console.log(
    `Inseridas ${confirmed.size} de ${inserts.length} (com slug gerado pelo upsertMany); atualizadas ${updated} de ${updates.length}.`
  )
  console.log(`Para desfazer: npm run sync:popular -- --restore ${backupFile}`)
  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
