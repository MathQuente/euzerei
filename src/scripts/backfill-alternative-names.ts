import 'dotenv/config'
import { prisma } from '../database/db'
import { IGDBService } from '../services/igdb.service'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { BATCH_SIZE, DELAY_MS, parseIntArg, sleep, withRetry } from './utils'

async function main() {
  const repo = new GameCacheRepository()

  let afterId = parseIntArg('--after') ?? 0
  let totalSeen = 0
  let totalNamed = 0

  console.log('Backfilling alternative names for cached games...')
  console.log(
    'Press Ctrl+C to stop (resume with --after <last igdb id printed>)\n'
  )

  while (true) {
    const igdbIds = await repo.findIdsAfter(afterId, BATCH_SIZE)
    if (igdbIds.length === 0) break

    const names = await withRetry(() =>
      IGDBService.getAlternativeNamesByIds(igdbIds)
    )
    const updates = igdbIds.map(igdbId => ({
      igdbId,
      alternativeNames: names.get(igdbId) ?? null
    }))
    await repo.updateAlternativeNames(updates)

    afterId = igdbIds[igdbIds.length - 1]
    totalSeen += igdbIds.length
    totalNamed += updates.filter(u => u.alternativeNames !== null).length
    process.stdout.write(
      `\rLast id ${afterId} | seen ${totalSeen} | with names ${totalNamed}`
    )

    await sleep(DELAY_MS)
  }

  console.log(
    `\nDone. Seen ${totalSeen}, with alternative names ${totalNamed}.`
  )
  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
