export const IMPORT_STORES = ['steam', 'xbox', 'psn'] as const
export type ImportStore = (typeof IMPORT_STORES)[number]

export const IMPORT_JOB_STATES = [
  'active',
  'waiting',
  'delayed',
  'completed',
  'failed'
] as const
export type ImportJobState = (typeof IMPORT_JOB_STATES)[number]

export type ImportStatus = 'failed' | 'running' | 'queued' | 'done' | 'warning'
export type ImportStatusFilter = 'failed' | 'running' | 'queued' | 'done'

export const STATES_BY_STATUS_FILTER: Record<
  ImportStatusFilter,
  readonly ImportJobState[]
> = {
  failed: ['failed'],
  running: ['active'],
  queued: ['waiting', 'delayed'],
  done: ['completed']
}

export interface ImportJobRecord {
  id: string
  store: ImportStore
  userId: string | null
  state: ImportJobState
  timestamp: number
  processedOn: number | null
  finishedOn: number | null
  attemptsMade: number
  maxAttempts: number
  failedReason: string | null
  returnValue: unknown
  progress: number | null
}

interface AccountResult {
  displayName?: unknown
  error?: unknown
}

interface LibraryResult {
  imported?: unknown
  updated?: unknown
  skipped?: unknown
  notFound?: unknown
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function accountsOf(returnValue: unknown): AccountResult[] {
  const accounts = (returnValue as { accounts?: unknown } | null)?.accounts
  return Array.isArray(accounts) ? (accounts as AccountResult[]) : []
}

export function accountErrors(returnValue: unknown): string[] {
  return accountsOf(returnValue)
    .map(account => account.error)
    .filter(
      (error): error is string => typeof error === 'string' && error !== ''
    )
}

export function accountNames(returnValue: unknown): string | null {
  const names = accountsOf(returnValue)
    .map(account => account.displayName)
    .filter((name): name is string => typeof name === 'string' && name !== '')
  return names.length > 0 ? names.join(', ') : null
}

export function gamesRead(returnValue: unknown): number | null {
  const library = (returnValue as { library?: LibraryResult } | null)?.library
  if (!library || typeof library !== 'object') return null
  const notFound = Array.isArray(library.notFound) ? library.notFound.length : 0
  return (
    asNumber(library.imported) +
    asNumber(library.updated) +
    asNumber(library.skipped) +
    notFound
  )
}

export function notFoundCount(returnValue: unknown): number | null {
  const library = (returnValue as { library?: LibraryResult } | null)?.library
  if (!library || !Array.isArray(library.notFound)) return null
  return library.notFound.length
}

export function statusOf(record: ImportJobRecord): ImportStatus {
  switch (record.state) {
    case 'failed':
      return 'failed'
    case 'active':
      return 'running'
    case 'waiting':
    case 'delayed':
      return 'queued'
    case 'completed':
      return accountErrors(record.returnValue).length > 0 ? 'warning' : 'done'
  }
}

export function sortKeyOf(record: ImportJobRecord): number {
  return record.finishedOn ?? record.processedOn ?? record.timestamp
}

export function durationOf(record: ImportJobRecord): number | null {
  if (record.finishedOn === null || record.processedOn === null) return null
  return Math.max(0, record.finishedOn - record.processedOn)
}

export function reasonOf(record: ImportJobRecord): string | null {
  if (record.state === 'failed') return record.failedReason
  if (record.state === 'completed')
    return accountErrors(record.returnValue)[0] ?? null
  return null
}
