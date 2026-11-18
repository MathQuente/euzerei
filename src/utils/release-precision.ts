export const RELEASE_PRECISIONS = [
  'day',
  'month',
  'q1',
  'q2',
  'q3',
  'q4',
  'year',
  'tbd'
] as const

export type ReleasePrecision = (typeof RELEASE_PRECISIONS)[number]

interface ReleaseDateEntry {
  date?: number
  date_format?: number
}

/** `date_format` da IGDB (endpoint `date_formats`): 0 dia, 1 mês, 2 ano, 3-6 trimestres, 7 a confirmar. */
const PRECISION_BY_FORMAT: Record<number, ReleasePrecision> = {
  0: 'day',
  1: 'month',
  2: 'year',
  3: 'q1',
  4: 'q2',
  5: 'q3',
  6: 'q4',
  7: 'tbd'
}

/** Da mais precisa para a menos precisa. */
const PRECISION_RANK: Record<ReleasePrecision, number> = {
  day: 0,
  month: 1,
  q1: 2,
  q2: 2,
  q3: 2,
  q4: 2,
  year: 3,
  tbd: 4
}

/** Valida o texto guardado no banco: um valor desconhecido vira "sem precisão". */
export function asReleasePrecision(
  value: string | null | undefined
): ReleasePrecision | undefined {
  return RELEASE_PRECISIONS.find(precision => precision === value)
}

export function precisionFromFormat(
  dateFormat: number | undefined
): ReleasePrecision | undefined {
  return dateFormat === undefined ? undefined : PRECISION_BY_FORMAT[dateFormat]
}

/**
 * Quão exata é `first_release_date`. A IGDB preenche esse campo com um dia
 * qualquer quando só se sabe o mês (dia 1), o trimestre ou o ano (31/12), e
 * com 31/12 também nas datas "a confirmar". Entre as datas de plataforma que
 * coincidem com `first_release_date` vale a mais precisa; se nenhuma
 * coincide, a data é inventada (`tbd`). Sem `release_dates` (ou sem
 * `date_format`, como nas cópias antigas do cache) a precisão é desconhecida.
 */
export function releaseDatePrecision(
  firstReleaseDate: number | undefined,
  releaseDates: ReleaseDateEntry[] | undefined
): ReleasePrecision | undefined {
  if (firstReleaseDate === undefined || !releaseDates?.length) return undefined

  const known = releaseDates.filter(
    entry => precisionFromFormat(entry.date_format) !== undefined
  )
  if (known.length === 0) return undefined

  const matching = known
    .filter(entry => entry.date === firstReleaseDate)
    .map(entry => precisionFromFormat(entry.date_format) as ReleasePrecision)
  if (matching.length === 0) {
    // Uma entrada com a mesma data mas sem formato conhecido não prova que a
    // data foi inventada: a precisão fica desconhecida, e não "tbd".
    const sameDateUnknown = releaseDates.some(
      entry =>
        entry.date === firstReleaseDate &&
        precisionFromFormat(entry.date_format) === undefined
    )
    return sameDateUnknown ? undefined : 'tbd'
  }

  return matching.reduce((best, current) =>
    PRECISION_RANK[current] < PRECISION_RANK[best] ? current : best
  )
}
