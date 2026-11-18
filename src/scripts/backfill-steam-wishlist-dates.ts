import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { Prisma } from '../database/prisma-client'
import { prisma } from '../database/db'
import { IGDBService } from '../services/igdb.service'
import { SteamApiService } from '../services/steam-api.service'
import {
  SteamDatedGame,
  WishlistRow,
  formatDateBackup,
  parseDateBackup,
  planWishlistDates
} from '../utils/steam-wishlist-dates'
import { parseStringArg, withRetry, writeBackupFile } from './utils'

const SAMPLES = 10

// Uso:
//   npm run backfill:steam-wishlist-dates                  simula, não grava
//   npm run backfill:steam-wishlist-dates -- --apply       grava (faz backup antes)
//   npm run backfill:steam-wishlist-dates -- --user <id>   só um usuário
//   npm run backfill:steam-wishlist-dates -- --restore <arquivo>   desfaz um --apply
// A importação gravava os desejos na ordem em que a Steam devolve (por appid),
// com a data do momento da importação. Aqui o created_at volta a ser a data
// em que o jogo entrou na lista da Steam. Só mexe em desejos de hoje que
// estão na lista da Steam; updated_at não muda.

function fmt(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Lê a lista de cada conta Steam; uma conta que falha é avisada e as outras seguem. */
async function steamGamesOf(userId: string): Promise<SteamDatedGame[] | null> {
  const accounts = await prisma.platformAccount.findMany({
    where: { userId, platform: 'STEAM' },
    select: { externalId: true }
  })
  const items: { appid: number; dateAdded?: number }[] = []
  let readable = 0
  for (const { externalId } of accounts) {
    try {
      const wishlist = await withRetry(async () => {
        const result = await SteamApiService.getWishlist(externalId)
        if (!result) throw new Error('Steam não devolveu a lista')
        return result
      })
      items.push(...wishlist)
      readable++
    } catch {
      console.log(`  conta Steam ${externalId}: a Steam não devolveu a lista.`)
    }
  }
  if (readable === 0) return null

  const matches = await withRetry(() =>
    IGDBService.getGamesBySteamAppIds([...new Set(items.map(i => i.appid))])
  )
  const igdbByAppId = new Map(matches.map(m => [m.appId, m.game.id]))
  // Um jogo em duas contas aparece duas vezes: o plano fica com a data mais antiga.
  return items.flatMap(({ appid, dateAdded }) => {
    const igdbId = igdbByAppId.get(appid)
    return igdbId === undefined ? [] : [{ igdbId, dateAdded }]
  })
}

function wishlistRowsOf(userId: string) {
  return prisma.$queryRaw<WishlistRow[]>(Prisma.sql`
    SELECT ug.id, ug.igdb_id AS "igdbId", ug.created_at AS "createdAt"
    FROM user_games ug
    JOIN users_games_status s ON s.id = ug.user_games_status_id
    WHERE ug.user_id = ${userId} AND s.status = 'WISHLIST'
  `)
}

async function restore(file: string, apply: boolean) {
  const rows = parseDateBackup(readFileSync(file, 'utf8'))
  // Só desfaz onde a data ainda é a que o backfill gravou.
  const current = await prisma.$queryRaw<{ id: string; createdAt: Date }[]>(
    Prisma.sql`SELECT id, created_at AS "createdAt" FROM user_games WHERE id IN (${Prisma.join(rows.map(r => r.id))})`
  )
  const createdAtById = new Map(current.map(r => [r.id, r.createdAt.getTime()]))
  const restorable = rows.filter(
    r => createdAtById.get(r.id) === r.next.getTime()
  )

  if (apply) {
    await prisma.$transaction(
      restorable.map(
        r =>
          prisma.$executeRaw`UPDATE user_games SET created_at = ${r.previous} WHERE id = ${r.id} AND created_at = ${r.next}`
      )
    )
  }
  console.log(
    `${apply ? '' : '[simulação] '}${rows.length} linhas no backup, ${restorable.length} ${apply ? 'restauradas' : 'seriam restauradas'} (só onde a data ainda é a gravada).`
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

  const only = parseStringArg('--user')
  const users = await prisma.platformAccount.findMany({
    where: { platform: 'STEAM', ...(only ? { userId: only } : {}) },
    distinct: ['userId'],
    select: { userId: true }
  })
  console.log(
    `${apply ? '' : '[simulação] '}${users.length} usuário(s) com conta Steam.`
  )

  const changes = []
  let skippedUsers = 0
  for (const { userId } of users) {
    const steamGames = await steamGamesOf(userId)
    if (!steamGames) {
      console.log(`Usuário ${userId}: a Steam não devolveu a lista, pulando.`)
      skippedUsers++
      continue
    }
    const plan = planWishlistDates(await wishlistRowsOf(userId), steamGames)
    console.log(
      `Usuário ${userId}: ${plan.changes.length} a corrigir, ${plan.alreadyRight} já certos, ${plan.notOnSteam} fora da lista da Steam (não mexo), ${plan.noDate} sem data na Steam.`
    )
    for (const c of plan.changes.slice(0, SAMPLES)) {
      console.log(`  ${c.igdbId}: ${fmt(c.previous)} -> ${fmt(c.next)}`)
    }
    changes.push(...plan.changes)
  }

  if (skippedUsers > 0) {
    console.log(
      `\nATENÇÃO: ${skippedUsers} usuário(s) pulado(s) porque a Steam não respondeu. Rode de novo mais tarde.`
    )
    process.exitCode = 1
  }
  if (changes.length === 0) {
    console.log(
      skippedUsers > 0
        ? 'Nada verificado para esses usuários.'
        : 'Nada a fazer.'
    )
    return
  }
  if (!apply) {
    console.log(
      `\n${changes.length} linhas mudariam. Rode com --apply para gravar.`
    )
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = `backfill-steam-wishlist-dates-${stamp}.jsonl`
  writeBackupFile(backupFile, `${formatDateBackup(changes)}\n`)
  console.log(`\nBackup gravado: ${backupFile} (${changes.length} linhas).`)

  await prisma.$transaction(
    changes.map(
      c =>
        prisma.$executeRaw`UPDATE user_games SET created_at = ${c.next} WHERE id = ${c.id}`
    )
  )
  console.log(`${changes.length} linhas atualizadas.`)
  console.log(
    `Para desfazer: npm run backfill:steam-wishlist-dates -- --restore ${backupFile} --apply`
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
