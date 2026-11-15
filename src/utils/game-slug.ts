const MAX_SLUG_LENGTH = 60

const LETTER_MAP: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i'
}

function foldLetters(text: string): string {
  return text.replace(/[øæœßłđðþı]/g, letter => LETTER_MAP[letter])
}

function cutAtWord(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug
  const cut = slug.slice(0, MAX_SLUG_LENGTH + 1)
  const lastDash = cut.lastIndexOf('-')
  const trimmed =
    lastDash > 0 ? cut.slice(0, lastDash) : cut.slice(0, MAX_SLUG_LENGTH)
  return trimmed.replace(/-+$/, '')
}

export function slugify(name: string): string {
  const slug = foldLetters(name.toLowerCase().normalize('NFKD'))
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cutAtWord(slug)
}

export function idSlug(name: string, igdbId: number): string {
  const slug = slugify(name)
  return slug === '' ? String(igdbId) : `${slug}-${igdbId}`
}

export function baseSlug(name: string, igdbId: number): string {
  const slug = slugify(name)
  return slug === '' || /^\d+$/.test(slug) ? idSlug(name, igdbId) : slug
}

export function slugCandidates(name: string, igdbId: number): string[] {
  return [baseSlug(name, igdbId), idSlug(name, igdbId)]
}

export function uniqueSlug(
  name: string,
  igdbId: number,
  isTaken: (slug: string) => boolean
): string {
  for (const candidate of slugCandidates(name, igdbId)) {
    if (!isTaken(candidate)) return candidate
  }
  return String(igdbId)
}
