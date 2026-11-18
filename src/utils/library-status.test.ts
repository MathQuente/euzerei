import { describe, expect, it } from 'vitest'
import {
  BACKLOG_STATUS_ID,
  DROPPED_STATUS_ID,
  PAUSED_STATUS_ID,
  PLAYING_STATUS_ID,
  droppedAtFor
} from './library-status'

const NOW = new Date('2026-11-18T12:00:00.000Z')

describe('droppedAtFor', () => {
  it('stamps the moment a game enters Larguei from another status', () => {
    expect(droppedAtFor(DROPPED_STATUS_ID, PLAYING_STATUS_ID, NOW)).toEqual(NOW)
    expect(droppedAtFor(DROPPED_STATUS_ID, PAUSED_STATUS_ID, NOW)).toEqual(NOW)
    expect(droppedAtFor(DROPPED_STATUS_ID, BACKLOG_STATUS_ID, NOW)).toEqual(NOW)
  })

  it('stamps a game created already dropped (no current status)', () => {
    expect(droppedAtFor(DROPPED_STATUS_ID, null, NOW)).toEqual(NOW)
  })

  it('keeps the date when the game is already dropped', () => {
    expect(
      droppedAtFor(DROPPED_STATUS_ID, DROPPED_STATUS_ID, NOW)
    ).toBeUndefined()
  })

  it('never touches the date for any other status, so it is not erased on leaving', () => {
    expect(
      droppedAtFor(PLAYING_STATUS_ID, DROPPED_STATUS_ID, NOW)
    ).toBeUndefined()
    expect(droppedAtFor(BACKLOG_STATUS_ID, null, NOW)).toBeUndefined()
  })
})
