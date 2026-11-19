import { slugify } from './game-slug'

export const HANDLE_MIN_LENGTH = 3
export const HANDLE_MAX_LENGTH = 30

/** Minúsculas, números, `_` e `-`; começa e termina com letra ou número. */
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/

/**
 * Handles que colidiriam com rotas estáticas de `/users/*` (ou com rotas do
 * app), para `/users/:ref` nunca resolver para a pessoa errada.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'me',
  'roulette',
  'favorites',
  'usergames',
  'featuredgames',
  'gamestatus',
  'games',
  'endless',
  'hundred-percent',
  'platforms',
  'playedcount',
  'hoursplayed',
  'completedat',
  'image-upload-signature',
  'handle-available',
  'steam',
  'psn',
  'xbox',
  'suggestions',
  'followers',
  'following',
  'admin',
  'api',
  'null',
  'undefined'
])

const FALLBACK_BASE = 'usuario'

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase())
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle) && !isReservedHandle(handle)
}

function trimEdges(value: string): string {
  return value.replace(/^[-_]+|[-_]+$/g, '')
}

/** "Matheus Silva" vira `matheussilva` (sem espaço); mantém `_` que já existia. */
export function toHandle(raw: string | null | undefined): string {
  const joined = (raw ?? '')
    .replace(/\s+/g, '')
    .split('_')
    .map(part => slugify(part))
    .filter(part => part !== '')
    .join('_')
  let handle = trimEdges(joined.slice(0, HANDLE_MAX_LENGTH))
  if (handle.length < HANDLE_MIN_LENGTH) {
    handle = trimEdges(`${FALLBACK_BASE}-${handle}`)
  }
  return handle
}

function withSuffix(base: string, suffix: string): string {
  const room = HANDLE_MAX_LENGTH - suffix.length
  return `${trimEdges(base.slice(0, room))}${suffix}`
}

/**
 * Primeiro handle livre a partir do nome: `base`, `base-2`, `base-3`…
 * `isTaken` compara sem diferenciar maiúsculas (handles já são minúsculos).
 */
export function uniqueHandle(
  raw: string | null | undefined,
  isTaken: (handle: string) => boolean
): string {
  const base = toHandle(raw)
  const free = (candidate: string) =>
    !isReservedHandle(candidate) && !isTaken(candidate)

  if (free(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = withSuffix(base, `-${n}`)
    if (free(candidate)) return candidate
  }
  return withSuffix(base, `-${Date.now().toString(36)}`)
}

/**
 * Prefixo comum a `base` e a todos os candidatos de `uniqueHandle` (que podem
 * encurtar a base para caber o sufixo `-123`), para buscar os já usados.
 */
export function handlePrefix(base: string): string {
  return base.slice(0, HANDLE_MAX_LENGTH - 8)
}

/** Termo de busca no formato dos handles: "Ana Lima" vira `analima`. */
export function toHandleSearch(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
}
