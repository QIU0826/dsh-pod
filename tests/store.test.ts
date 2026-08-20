import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuplicateIdError, NotFoundError, StoreCorruptError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import type { Mission } from '../src/core/types.js'

let root: string
let clockNow: number

function makeStore() {
  return new JsonStore({ rootDir: root, clock: () => clockNow })
}

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'test mission',
    goal: 'ship it',
    status: 'planning',
    budget_usd: 2,
    spent_tokens: 0,
    spent_equiv_usd: 0,
    approval_mode: 1,
    cwd: 'C:\\repo',
    worktree_policy: 'per-slot',
    orchestration_mode: 'commander',
    commander_healthy: true,
    created_at: clockNow,
    updated_at: clockNow,
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-store-'))
  clockNow = 1_700_000_000_000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('JsonStore.open', () => {
  it('creates a fresh store with schema version 1 and empty collections', () => {
    const store = makeStore()
    store.open()
    expect(store.listMissions()).toEqual([])
    expect(existsSync(join(root, 'store.json'))).toBe(true)
    expect(store.getSchemaVersion()).toBe(1)
  })

  it('persists data across close and reopen', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    const reopened = makeStore()
    reopened.open()
    expect(reopened.getMission('M-1')?.name).toBe('test mission')
  })

  it('recovers from a corrupt primary file using the .bak backup', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    store.createMission(makeMission({ id: 'M-2', name: 'second' }))
    // Corrupt the primary but keep the .bak intact.
    writeFileSync(join(root, 'store.json'), '{"schemaVersion":1,"missions":{trunc')
    const reopened = makeStore()
    reopened.open()
    // .bak holds the state after the first write (only M-1).
    expect(reopened.getMission('M-1')).toBeDefined()
    // The corrupt file must be preserved for forensics.
    expect(readdirSync(root).some((f) => f.startsWith('store.json.corrupt-'))).toBe(true)
  })

  it('throws StoreCorruptError when both primary and backup are corrupt', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    writeFileSync(join(root, 'store.json'), 'not json {')
    writeFileSync(join(root, 'store.json.bak'), 'also not json [')
    const reopened = makeStore()
    expect(() => reopened.open()).toThrowError(StoreCorruptError)
  })

  it('state mutations write a valid JSON file synchronously; buffered events flush on flush()', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    let raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw).toContain('M-1')
    store.appendEvent('M-1', { id: 'E-1', mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(raw).not.toContain('E-1')
    store.flush()
    raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(raw).toContain('E-1')
  })
})

describe('JsonStore mutations', () => {
  it('creates and reads a mission with the injected clock', () => {
    const store = makeStore()
    store.open()
    clockNow = 1_700_000_123_000
    store.createMission(makeMission())
    const got = store.getMission('M-1')!
    expect(got.created_at).toBe(1_700_000_123_000)
    expect(got.updated_at).toBe(1_700_000_123_000)
  })

  it('rejects duplicate mission ids', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    expect(() => store.createMission(makeMission())).toThrowError(DuplicateIdError)
  })

  it('updateMission patches fields and bumps updated_at', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    clockNow += 5_000
    store.updateMission('M-1', { status: 'running' })
    const got = store.getMission('M-1')!
    expect(got.status).toBe('running')
    expect(got.updated_at).toBe(clockNow)
  })

  it('updateMission on a missing mission throws NotFoundError', () => {
    const store = makeStore()
    store.open()
    expect(() => store.updateMission('nope', { status: 'done' })).toThrowError(NotFoundError)
  })

  it('appendEvent caps the event log per mission in memory and persists on flush', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    for (let i = 0; i < 2500; i++) {
      store.appendEvent('M-1', { id: `E-${i}`, mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    }
    const events = store.listEvents('M-1')
    expect(events).toHaveLength(2000)
    expect(events[0]!.id).toBe('E-500')
    store.flush()
    const reopened = makeStore()
    reopened.open()
    expect(reopened.listEvents('M-1')).toHaveLength(2000)
    expect(reopened.listEvents('M-1')[0]!.id).toBe('E-500')
  })

  it('getActiveMission returns the single non-terminal mission', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission({ id: 'M-done', status: 'done' }))
    store.createMission(makeMission({ id: 'M-live', status: 'running' }))
    expect(store.getActiveMission()?.id).toBe('M-live')
  })
})
