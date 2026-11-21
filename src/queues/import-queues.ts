import { bullConnection } from './connection'
import { psnImportQueue } from './psn-import.queue'
import { steamImportQueue } from './steam-import.queue'
import { xboxImportQueue } from './xbox-import.queue'
import type { ImportQueues } from '../repositories/import-queue.repository'

export const importQueues: ImportQueues = {
  steam: steamImportQueue,
  xbox: xboxImportQueue,
  psn: psnImportQueue
}

export const importQueuesRedis = bullConnection
