import type { Prisma } from '../database/prisma-client'
import type { AdminUsersFilter } from '../schemas/admin-users.schema'
import { escapeLike } from './escape-like'
import { TERMS_VERSION } from './terms'

export interface AdminUsersFilters {
  q?: string
  filter: AdminUsersFilter
}

function filterWhere(filter: AdminUsersFilter): Prisma.UserWhereInput {
  switch (filter) {
    case 'emailPending':
      return { emailVerifiedAt: null }
    case 'suspended':
      return { suspendedAt: { not: null } }
    case 'noStore':
      return { accounts: { none: {} } }
    case 'noTerms':
      return {
        OR: [{ termsVersion: null }, { termsVersion: { not: TERMS_VERSION } }]
      }
    default:
      return {}
  }
}

export function buildAdminUsersWhere(
  filters: AdminUsersFilters
): Prisma.UserWhereInput {
  const text = filters.q?.replace(/^@+/, '').trim()
  const and: Prisma.UserWhereInput[] = [filterWhere(filters.filter)]

  if (text) {
    const contains = {
      contains: escapeLike(text),
      mode: 'insensitive' as const
    }
    and.push({ OR: [{ userName: contains }, { email: contains }] })
  }

  return { AND: and }
}
