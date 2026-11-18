export interface WishlistRow {
  id: string
  igdbId: number
  createdAt: Date
}

export interface SteamDatedGame {
  igdbId: number
  /** Segundos desde 1970: quando o jogo entrou na lista de desejos da Steam. */
  dateAdded?: number
}

export interface DateChange {
  id: string
  igdbId: number
  previous: Date
  next: Date
}

export interface WishlistDatePlan {
  changes: DateChange[]
  alreadyRight: number
  /** Desejos que não estão na lista da Steam (adicionados à mão, por exemplo). */
  notOnSteam: number
  /** Estão na lista da Steam, mas sem data de adição. */
  noDate: number
}

/** Mesmo jogo em mais de uma conta, ou resolvido duas vezes: vale a data mais antiga. */
export function earliestDatePerGame(
  games: SteamDatedGame[]
): Map<number, number | undefined> {
  const byGame = new Map<number, number | undefined>()
  for (const { igdbId, dateAdded } of games) {
    const known = byGame.get(igdbId)
    if (!byGame.has(igdbId)) {
      byGame.set(igdbId, dateAdded)
    } else if (dateAdded && (!known || dateAdded < known)) {
      byGame.set(igdbId, dateAdded)
    }
  }
  return byGame
}

/**
 * Só mexe nos desejos de hoje que estão na lista da Steam e têm data de
 * adição; o resto da biblioteca nunca entra no plano.
 */
export function planWishlistDates(
  rows: WishlistRow[],
  steamGames: SteamDatedGame[]
): WishlistDatePlan {
  const dates = earliestDatePerGame(steamGames)
  const plan: WishlistDatePlan = {
    changes: [],
    alreadyRight: 0,
    notOnSteam: 0,
    noDate: 0
  }

  for (const row of rows) {
    if (!dates.has(row.igdbId)) {
      plan.notOnSteam++
      continue
    }
    const dateAdded = dates.get(row.igdbId)
    if (!dateAdded) {
      plan.noDate++
      continue
    }
    const next = new Date(dateAdded * 1000)
    if (next.getTime() === row.createdAt.getTime()) {
      plan.alreadyRight++
      continue
    }
    plan.changes.push({
      id: row.id,
      igdbId: row.igdbId,
      previous: row.createdAt,
      next
    })
  }

  return plan
}

export function formatDateBackup(changes: DateChange[]): string {
  return changes
    .map(c =>
      JSON.stringify({
        id: c.id,
        igdbId: c.igdbId,
        previous: c.previous.toISOString(),
        next: c.next.toISOString()
      })
    )
    .join('\n')
}

export function parseDateBackup(text: string): DateChange[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Invalid backup line: "${line}"`)
      }
      const row = value as {
        id?: unknown
        igdbId?: unknown
        previous?: unknown
        next?: unknown
      }
      const previous = new Date(String(row.previous))
      const next = new Date(String(row.next))
      if (
        typeof row.id !== 'string' ||
        !Number.isInteger(row.igdbId) ||
        Number.isNaN(previous.getTime()) ||
        Number.isNaN(next.getTime())
      ) {
        throw new Error(`Invalid backup line: "${line}"`)
      }
      return { id: row.id, igdbId: row.igdbId as number, previous, next }
    })
}
