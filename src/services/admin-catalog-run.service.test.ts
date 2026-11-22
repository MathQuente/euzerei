import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  AdminCatalogRunService,
  FLUSH_MS,
  type Spawner
} from './admin-catalog-run.service'
import type { RunState, RunStore } from '../repositories/catalog-run.repository'
import type { RunCommand } from '../utils/catalog-run-command'

const ACTOR = { actorId: 'admin-1', ip: '127.0.0.1' }

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn((signal?: string) => {
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  })
  out(text: string) {
    this.stdout.write(text)
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

function memoryStore() {
  let lock: { runId: string; key: string; mode: string } | null = null
  let state: RunState | null = null
  let log: string[] = []
  const store: RunStore = {
    acquire: vi.fn(async (runId, payload) => {
      if (lock) return false
      lock = { runId, ...payload }
      return true
    }),
    heartbeat: vi.fn(async runId => lock?.runId === runId),
    release: vi.fn(async runId => {
      if (lock?.runId === runId) lock = null
    }),
    readLock: vi.fn(async () => lock),
    saveState: vi.fn(async s => void (state = s)),
    readState: vi.fn(async () => state),
    resetLog: vi.fn(async () => void (log = [])),
    pushLog: vi.fn(async line => void log.push(line)),
    readLog: vi.fn(async () => [...log])
  }
  return {
    store,
    peek: () => ({ lock, state, log }),
    setLock: (l: typeof lock) => (lock = l),
    setState: (s: RunState | null) => (state = s)
  }
}

let child: FakeChild
let commands: RunCommand[]
const spawner: Spawner = command => {
  commands.push(command)
  return child as never
}
const audit = { create: vi.fn(), markFailed: vi.fn(), markFinished: vi.fn() }
const onFinished = vi.fn()

function build(store: RunStore, isAlive = () => false) {
  return new AdminCatalogRunService(store, audit, {
    spawner,
    isAlive,
    onFinished,
    env: { CATALOG_SCRIPTS_DIR: '/stubs' }
  })
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(FLUSH_MS + 10)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  child = new FakeChild()
  commands = []
  vi.clearAllMocks()
  audit.create.mockResolvedValue({ id: 'audit-1' })
  audit.markFailed.mockResolvedValue({})
  audit.markFinished.mockResolvedValue({})
})
afterEach(() => vi.useRealTimers())

describe('start', () => {
  it('simular: manda só os argumentos de simulação e não grava auditoria', async () => {
    const { store } = memoryStore()
    const run = await build(store).start('slugs', 'dry', ACTOR)

    expect(run.run).toMatchObject({
      key: 'slugs',
      mode: 'dry',
      status: 'running'
    })
    expect(commands[0].args).toEqual(['/stubs/backfill-slugs.js'])
    expect(audit.create).not.toHaveBeenCalled()
  })

  it('rodar: grava a auditoria ANTES de subir o processo e manda os argumentos de gravar', async () => {
    const order: string[] = []
    audit.create.mockImplementation(
      async () => (order.push('audit'), { id: 'audit-1' })
    )
    const { store } = memoryStore()
    const service = new AdminCatalogRunService(store, audit, {
      spawner: command => (
        order.push('spawn'),
        commands.push(command),
        child as never
      ),
      env: { CATALOG_SCRIPTS_DIR: '/stubs' }
    })

    await service.start('slugs', 'apply', ACTOR)

    expect(order).toEqual(['audit', 'spawn'])
    expect(commands[0].args).toEqual(['/stubs/backfill-slugs.js', '--apply'])
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Rodou o backfill de slugs',
        area: 'CATALOG',
        actorId: 'admin-1'
      })
    )
  })

  it.each([
    ['job desconhecido', 'nao-existe', 'apply', 404],
    ['modo que o job não tem', 'slugs', 'dry', null]
  ] as const)('%s', async (_name, key, mode, status) => {
    const { store } = memoryStore()
    if (status) {
      await expect(build(store).start(key, mode, ACTOR)).rejects.toMatchObject({
        statusCode: status
      })
    } else {
      await expect(build(store).start(key, mode, ACTOR)).resolves.toBeTruthy()
    }
  })

  it('segunda execução enquanto há uma rodando: 409 com o nome do job, sem auditoria nem processo', async () => {
    const { store } = memoryStore()
    const service = build(store)
    await service.start('covers', 'dry', ACTOR)
    audit.create.mockClear()
    commands.length = 0

    await expect(service.start('slugs', 'apply', ACTOR)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Capas')
    })
    expect(audit.create).not.toHaveBeenCalled()
    expect(commands).toHaveLength(0)
  })

  it('auditoria falha: nada roda e a trava é solta', async () => {
    audit.create.mockRejectedValue(new Error('db'))
    const { store, peek } = memoryStore()

    await expect(build(store).start('slugs', 'apply', ACTOR)).rejects.toThrow(
      'db'
    )
    expect(commands).toHaveLength(0)
    expect(peek().lock).toBeNull()
  })

  it('processo que não sobe: 503, trava solta e a MESMA linha de auditoria vira FAILED', async () => {
    child.pid = undefined as never
    const { store, peek } = memoryStore()

    await expect(
      build(store).start('slugs', 'apply', ACTOR)
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(peek().lock).toBeNull()
    expect(audit.markFailed).toHaveBeenCalledWith('audit-1', expect.any(String))
  })

  it('processo anterior órfão ainda vivo (trava expirou): 409', async () => {
    const { store, setState } = memoryStore()
    setState({
      runId: 'velho',
      key: 'hypes',
      mode: 'apply',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: 999,
      exitCode: null,
      progress: null,
      summary: null,
      auditId: 'a0'
    })

    await expect(
      build(store, () => true).start('slugs', 'apply', ACTOR)
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('anterior')
    })
  })

  it('o pid guardado só vale se for o script daquele job: a checagem recebe o arquivo do job', async () => {
    const { store, setState } = memoryStore()
    setState({
      runId: 'velho',
      key: 'hypes',
      mode: 'apply',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: 999,
      exitCode: null,
      progress: null,
      summary: null,
      auditId: 'a0'
    })
    const isAlive = vi.fn(() => false)

    await build(store, isAlive).start('slugs', 'dry', ACTOR)

    expect(isAlive).toHaveBeenCalledWith(999, 'backfill-hypes')
  })

  it('cancelar não mata um pid que não é o do job (pid reaproveitado depois de reiniciar)', async () => {
    const { store, setState, setLock } = memoryStore()
    setState({
      runId: 'velho',
      key: 'hypes',
      mode: 'apply',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: process.pid,
      exitCode: null,
      progress: null,
      summary: null,
      auditId: 'a0'
    })
    setLock({ runId: 'velho', key: 'hypes', mode: 'apply' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    await expect(build(store, () => false).cancel()).rejects.toMatchObject({
      statusCode: 409
    })
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  it('processo anterior morto sem avisar: fecha o registro como falho, a linha vira FAILED e a nova execução segue', async () => {
    const { store, setState, peek } = memoryStore()
    setState({
      runId: 'velho',
      key: 'hypes',
      mode: 'apply',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: 999,
      exitCode: null,
      progress: null,
      summary: null,
      auditId: 'a0'
    })

    await build(store, () => false).start('slugs', 'dry', ACTOR)

    expect(audit.markFailed).toHaveBeenCalledWith(
      'a0',
      expect.stringContaining('parou')
    )
    expect(peek().lock?.key).toBe('slugs')
  })
})

describe('durante e depois da execução', () => {
  it('guarda as linhas (sem segredo), mostra o progresso e a linha final', async () => {
    const { store } = memoryStore()
    const service = build(store)
    await service.start('hypes', 'dry', ACTOR)

    child.out(
      '[dry run] 120 jogos\nFalhou em https://x?client_secret=topsecret&a=1\nRound 1\rRound 2'
    )
    await settle()
    const view = await service.current()

    expect(view.lines).toEqual([
      '[dry run] 120 jogos',
      'Falhou em https://x?client_secret=…&a=1'
    ])
    expect(view.lines.join(' ')).not.toContain('topsecret')
    expect(view.run?.progress).toBe('Round 2')
  })

  it('o progresso que termina em \\n vira linha e não volta depois: a última linha é a final', async () => {
    const { store, peek } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'apply', ACTOR)
    child.out('\rRound 1\rRound 2 | +20\nDone. Total updated this run: 20\n')
    await settle()
    child.exit(0)
    await vi.advanceTimersByTimeAsync(10)

    expect(peek().log).toEqual([
      'Round 2 | +20',
      'Done. Total updated this run: 20'
    ])
    expect(peek().state?.summary).toBe('Done. Total updated this run: 20')
  })

  it('sai com 0: status done, trava solta, linha de auditoria concluída com o resumo, cache invalidado', async () => {
    const { store, peek } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'apply', ACTOR)
    child.out('Done. Total updated this run: 9\n')
    await settle()
    child.exit(0)
    await vi.advanceTimersByTimeAsync(10)

    expect(peek().state).toMatchObject({
      status: 'done',
      exitCode: 0,
      summary: 'Done. Total updated this run: 9'
    })
    expect(peek().lock).toBeNull()
    expect(audit.markFinished).toHaveBeenCalledWith(
      'audit-1',
      expect.stringContaining('Done. Total updated this run: 9')
    )
    expect(audit.markFailed).not.toHaveBeenCalled()
    expect(onFinished).toHaveBeenCalled()
  })

  it.each([
    ['precision', true],
    ['covers', true],
    ['slugs', false]
  ] as const)(
    'rodar %s: o caminho do backup %s na linha de auditoria',
    async (key, writes) => {
      const { store } = memoryStore()
      const service = build(store)
      await service.start(key, 'apply', ACTOR)
      child.out('Done. Total updated this run: 1\n')
      await settle()
      child.exit(0)
      await vi.advanceTimersByTimeAsync(10)

      const detail = audit.markFinished.mock.calls[0][1] as string
      expect(detail.includes('Backups, se o script criou, em ')).toBe(writes)
      if (writes) expect(detail).toContain('some quando o contêiner reinicia')
    }
  )

  it('o aviso do backup também vai na linha que virou FAILED', async () => {
    const { store } = memoryStore()
    const service = build(store)
    await service.start('precision', 'apply', ACTOR)
    child.exit(1)
    await vi.advanceTimersByTimeAsync(10)

    expect(audit.markFailed.mock.calls[0][1]).toContain(
      'Backups, se o script criou, em '
    )
  })

  it('sai com erro: status failed e a MESMA linha vira FAILED com o código e a última linha', async () => {
    const { store, peek } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'apply', ACTOR)
    child.stderr.write('IGDB 500\n')
    await settle()
    child.exit(1)
    await vi.advanceTimersByTimeAsync(10)

    expect(peek().state?.status).toBe('failed')
    expect(audit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      expect.stringMatching(/código 1.*IGDB 500/)
    )
    expect(audit.create).toHaveBeenCalledTimes(1)
    expect(peek().lock).toBeNull()
  })

  it('simulação que termina não mexe na auditoria', async () => {
    const { store } = memoryStore()
    await build(store).start('covers', 'dry', ACTOR)
    child.exit(0)
    await vi.advanceTimersByTimeAsync(10)

    expect(audit.markFinished).not.toHaveBeenCalled()
    expect(audit.markFailed).not.toHaveBeenCalled()
  })

  it('depois de terminar dá para rodar outro', async () => {
    const { store } = memoryStore()
    const service = build(store)
    await service.start('covers', 'dry', ACTOR)
    child.exit(0)
    await vi.advanceTimersByTimeAsync(10)
    child = new FakeChild()

    await expect(service.start('slugs', 'dry', ACTOR)).resolves.toBeTruthy()
  })

  it('o heartbeat renova a trava a cada 30 s', async () => {
    const { store } = memoryStore()
    await build(store).start('covers', 'dry', ACTOR)
    await vi.advanceTimersByTimeAsync(65_000)

    expect(store.heartbeat).toHaveBeenCalledTimes(2)
  })
})

describe('cancelar e encerrar', () => {
  it('cancelar: manda SIGTERM, status cancelled, linha de auditoria FAILED "Cancelada"', async () => {
    const { store, peek } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'apply', ACTOR)

    expect(await service.cancel()).toEqual({ cancelling: true })
    await vi.advanceTimersByTimeAsync(10)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(peek().state?.status).toBe('cancelled')
    expect(audit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      expect.stringContaining('Cancelada')
    )
    expect(peek().lock).toBeNull()
  })

  it('cancelar sem execução: 409', async () => {
    const { store } = memoryStore()

    await expect(build(store).cancel()).rejects.toMatchObject({
      statusCode: 409
    })
  })

  it('o processo que ignora o SIGTERM leva SIGKILL depois da tolerância', async () => {
    child.kill = vi.fn(() => true) as never
    const { store } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'dry', ACTOR)
    await service.cancel()
    await vi.advanceTimersByTimeAsync(10_500)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('encerrar a API mata o filho e fecha a linha de auditoria como interrompida', async () => {
    const { store, peek } = memoryStore()
    const service = build(store)
    await service.start('slugs', 'apply', ACTOR)

    const stopped = service.stopAll()
    await vi.advanceTimersByTimeAsync(20)
    await stopped

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(audit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      expect.stringContaining('reiniciada')
    )
    expect(peek().lock).toBeNull()
  })

  it('encerrar sem execução não faz nada', async () => {
    const { store } = memoryStore()

    await expect(build(store).stopAll()).resolves.toBeUndefined()
  })
})

describe('current', () => {
  it('sem execução: run nulo e nenhuma linha', async () => {
    const { store } = memoryStore()

    expect(await build(store).current()).toEqual({ run: null, lines: [] })
  })

  it('nunca expõe pid nem o id da linha de auditoria', async () => {
    const { store } = memoryStore()
    const service = build(store)
    await service.start('covers', 'apply', ACTOR)
    const json = JSON.stringify(await service.current())

    expect(json).not.toContain('4242')
    expect(json).not.toContain('audit-1')
    expect(json).not.toContain('auditId')
  })
})
