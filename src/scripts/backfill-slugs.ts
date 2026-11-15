import 'dotenv/config'
import { prisma } from '../database/db'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { slugify, uniqueSlug } from '../utils/game-slug'

const BATCH_SIZE = 2000
const SAMPLE_SIZE = 15

const apply = process.argv.includes('--apply')

async function main() {
  const repo = new GameCacheRepository()
  const used = new Set(await repo.findAllSlugs())
  console.log(`${used.size} slugs already assigned.`)

  let lastId = 0
  let seen = 0
  let assigned = 0
  let withId = 0
  let written = 0
  let duplicates = 0
  let bareIds = 0
  const samples: string[] = []

  while (true) {
    const batch = await repo.findSlugBackfillBatchAfter(lastId, BATCH_SIZE)
    if (batch.length === 0) break
    lastId = batch[batch.length - 1].igdbId
    seen += batch.length

    const updates: Array<{ igdbId: number; slug: string }> = []
    for (const game of batch) {
      if (game.slug !== null) continue
      const slug = uniqueSlug(game.name, game.igdbId, s => used.has(s))
      if (used.has(slug)) duplicates++
      used.add(slug)
      if (/^\d+$/.test(slug)) bareIds++
      updates.push({ igdbId: game.igdbId, slug })
      assigned++
      if (slug !== slugify(game.name)) {
        withId++
        if (samples.length < SAMPLE_SIZE) {
          samples.push(`${game.igdbId} ${game.name.slice(0, 40)} -> ${slug}`)
        }
      }
    }

    if (apply) {
      written += await repo.assignMissingSlugs(updates.map(u => u.igdbId))
    }
  }

  console.log(`${seen} games scanned, ${assigned} need a slug.`)
  console.log(
    `${withId} of them get the id in the slug (empty name or collision).`
  )
  console.log(
    `Duplicate slugs assigned: ${duplicates} (must be 0). All-digit slugs (empty names): ${bareIds}.`
  )
  if (samples.length > 0) console.log('Samples:\n' + samples.join('\n'))
  console.log(
    apply
      ? `Applied: ${written} rows updated.`
      : 'Dry-run: nothing written. Pass --apply to save.'
  )
  await prisma.$disconnect()
}

main().catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
