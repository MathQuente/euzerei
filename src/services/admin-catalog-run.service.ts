import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { ClientError } from '../errors/client-error'
import { AuditRepository } from '../repositories/audit.repository'
import {
  CatalogRunRepository,
  type RunState,
  type RunStore
} from '../repositories/catalog-run.repository'
import {
  CATALOG_JOBS,
  type CatalogJobDefinition
} from '../utils/admin-catalog-jobs'
import {
  resolveRunCommand,
  type RunCommand
} from '../utils/catalog-run-command'
import { LineSplitter, redactLogLine } from '../utils/redact-log'
import { pidRunsScript } from '../utils/process-identity'
import { logError } from '../utils/respond-unavailable'

export const HEARTBEAT_MS = 30_000
export const FLUSH_MS = 1_000
export const KILL_GRACE_MS = 10_000

export interface RunActor {
  actorId: string
  ip: string
}

export type RunMode = 'dry' | 'apply'

type ChildLike = Pick<ChildProcess, 'pid' | 'stdout' | 'stderr' | 'on' | 'kill'>
export type Spawner = (command: RunCommand) => ChildLike

const defaultSpawner: Spawner = command =>
  spawn(command.command, command.args, {
    cwd: command.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

interface Active {
  runId: string
  child: ChildLike
  auditId: string | null
  /** Quando o job grava backup, onde ele fica (vai na linha de auditoria). */
  backupNote: string
  cancelReason: string | null
  pending: string[]
  progress: string | null
  state: RunState
  timers: ReturnType<typeof setInterval>[]
  done: Promise<void>
}

export class AdminCatalogRunService {
  private active: Active | null = null

  constructor(
    private store: RunStore = new CatalogRunRepository(),
    private strictAudit: Pick<
      AuditRepository,
      'create' | 'markFailed' | 'markFinished'
    > = new AuditRepository(),
    private deps: {
      spawner?: Spawner
      /** O pid está vivo e é o script desse job? (nunca só "existe": o pid pode ter sido reaproveitado) */
      isAlive?: (pid: number, scriptFile: string) => boolean
      env?: Record<string, string | undefined>
      onFinished?: () => void
      now?: () => Date
    } = {}
  ) {}

  private get now() {
    return this.deps.now?.() ?? new Date()
  }

  private jobOf(key: string): CatalogJobDefinition {
    const job = CATALOG_JOBS.find(candidate => candidate.key === key)
    if (!job) throw new ClientError('Job desconhecido.', 404)
    return job
  }

  async start(key: string, mode: RunMode, actor: RunActor) {
    const job = this.jobOf(key)
    const args = mode === 'dry' ? job.dryArgs : job.applyArgs
    if (args === null) {
      throw new ClientError('Este job não tem simulação.', 400)
    }

    await this.reconcile()
    const runId = randomUUID()
    if (!(await this.store.acquire(runId, { key, mode }))) {
      const busy = await this.store.readLock()
      const title = busy ? this.titleOf(busy.key) : 'outro job'
      throw new ClientError(
        `Já há uma execução em andamento (${title}). Espere ela terminar ou cancele.`,
        409
      )
    }

    let auditId: string | null = null
    try {
      // Auditoria ANTES, estrita: se ela falha, nada roda. Simulação não grava nada, então não é auditada.
      if (mode === 'apply') {
        const entry = await this.strictAudit.create({
          actorId: actor.actorId,
          action: job.action,
          area: 'CATALOG',
          target: job.title,
          detail: 'Iniciada.',
          ip: actor.ip
        })
        auditId = entry.id
      }
      return await this.launch(job, mode, args, runId, auditId)
    } catch (error) {
      await this.store.release(runId).catch(() => undefined)
      if (auditId)
        await this.failAudit(auditId, 'Não foi possível iniciar o processo.')
      throw error
    }
  }

  private isRunner(pid: number, key: string) {
    const file = CATALOG_JOBS.find(job => job.key === key)?.file
    if (!file) return false
    return (this.deps.isAlive ?? pidRunsScript)(pid, file)
  }

  private titleOf(key: string) {
    return CATALOG_JOBS.find(job => job.key === key)?.title ?? key
  }

  private async launch(
    job: CatalogJobDefinition,
    mode: RunMode,
    args: readonly string[],
    runId: string,
    auditId: string | null
  ) {
    const command = resolveRunCommand(job, args, this.deps.env ?? process.env)
    const child = (this.deps.spawner ?? defaultSpawner)(command)
    if (!child.pid) {
      throw new ClientError('Não foi possível iniciar o processo.', 503)
    }

    const state: RunState = {
      runId,
      key: job.key,
      mode,
      status: 'running',
      startedAt: this.now.toISOString(),
      finishedAt: null,
      pid: child.pid,
      exitCode: null,
      progress: null,
      summary: null,
      auditId
    }
    await this.store.resetLog()
    await this.store.saveState(state)

    let finish!: () => void
    const done = new Promise<void>(resolve => (finish = resolve))
    const active: Active = {
      runId,
      child,
      auditId,
      backupNote:
        mode === 'apply' && job.writesBackup
          ? ` Backups, se o script criou, em ${command.cwd} (some quando o contêiner reinicia).`
          : '',
      cancelReason: null,
      pending: [],
      progress: null,
      state,
      timers: [],
      done
    }
    this.active = active

    const splitter = new LineSplitter(
      line => {
        // Uma linha completa substitui o progresso que estava na tela: o "Round 2…" que terminou em \n já virou linha.
        active.progress = null
        active.pending.push(redactLogLine(line))
      },
      line => (active.progress = redactLogLine(line))
    )
    const feed = (chunk: Buffer | string) => splitter.feed(chunk.toString())
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)

    active.timers.push(
      setInterval(() => void this.flush(active), FLUSH_MS),
      setInterval(() => {
        this.store
          .heartbeat(runId)
          .catch(error => logError('[CatalogRun] heartbeat failed', error))
      }, HEARTBEAT_MS)
    )
    active.timers.forEach(timer => timer.unref?.())

    let ended = false
    const end = (
      code: number | null,
      signal: string | null,
      spawnError?: Error
    ) => {
      if (ended) return
      ended = true
      splitter.end()
      void this.finish(active, code, signal, spawnError).finally(finish)
    }
    child.on('exit', (code, signal) => end(code, signal))
    child.on('error', error => end(null, null, error))

    return this.view(state, [])
  }

  private async flush(active: Active) {
    const lines = active.pending.splice(0)
    try {
      for (const line of lines) await this.store.pushLog(line)
      active.state = { ...active.state, progress: active.progress }
      await this.store.saveState(active.state)
    } catch (error) {
      logError('[CatalogRun] could not save progress', error)
    }
  }

  private async finish(
    active: Active,
    code: number | null,
    signal: string | null,
    spawnError?: Error
  ) {
    active.timers.forEach(timer => clearInterval(timer))
    if (active.progress) active.pending.push(active.progress)
    active.progress = null
    await this.flush(active)

    const cancelled = active.cancelReason !== null
    const status = cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed'
    const lines = await this.store.readLog().catch(() => [] as string[])
    const last = lines.at(-1) ?? null
    const summary = spawnError ? 'Não foi possível iniciar o processo.' : last
    const finishedAt = this.now
    const seconds = Math.max(
      0,
      Math.round(
        (finishedAt.getTime() - new Date(active.state.startedAt).getTime()) /
          1000
      )
    )
    active.state = {
      ...active.state,
      status,
      finishedAt: finishedAt.toISOString(),
      exitCode: code,
      progress: null,
      summary
    }
    try {
      await this.store.saveState(active.state)
    } catch (error) {
      logError('[CatalogRun] could not save final state', error)
    }
    await this.store.release(active.runId).catch(() => undefined)

    if (active.auditId) {
      if (status === 'done') {
        await this.auditFinished(
          active.auditId,
          `Concluída em ${seconds} s${summary ? `: ${summary}` : '.'}${active.backupNote}`
        )
      } else if (cancelled) {
        await this.failAudit(
          active.auditId,
          `${active.cancelReason!}${active.backupNote}`
        )
      } else {
        const why = signal
          ? `sinal ${signal}`
          : `código ${code ?? 'desconhecido'}`
        await this.failAudit(
          active.auditId,
          `Falhou (${why})${summary ? `: ${summary}` : '.'}${active.backupNote}`
        )
      }
    }
    if (this.active === active) this.active = null
    try {
      this.deps.onFinished?.()
    } catch (error) {
      logError('[CatalogRun] onFinished failed', error)
    }
  }

  private async auditFinished(id: string, detail: string) {
    try {
      await this.strictAudit.markFinished(id, detail.slice(0, 400))
    } catch (error) {
      logError('[CatalogRun] could not finish audit row', error)
    }
  }

  private async failAudit(id: string, detail: string) {
    try {
      await this.strictAudit.markFailed(id, detail.slice(0, 400))
    } catch (error) {
      logError('[CatalogRun] could not mark audit row as failed', error)
    }
  }

  /**
   * Uma execução que o Redis ainda diz "rodando" mas sem trava: se o processo morreu, fecha o registro como falho;
   * se ainda está vivo (a API anterior caiu à força e o filho ficou órfão), segue como ocupado.
   */
  private async reconcile() {
    if (this.active) return
    const state = await this.store.readState()
    if (!state || state.status !== 'running') return
    const lock = await this.store.readLock()
    if (lock?.runId === state.runId) return
    const alive = state.pid !== null && this.isRunner(state.pid, state.key)
    if (alive) {
      throw new ClientError(
        'Um processo da execução anterior ainda está rodando. Espere ele terminar.',
        409
      )
    }
    const closed: RunState = {
      ...state,
      status: 'failed',
      finishedAt: this.now.toISOString(),
      summary: 'O processo parou sem avisar (a API foi reiniciada?).'
    }
    await this.store.saveState(closed)
    if (state.auditId) await this.failAudit(state.auditId, closed.summary!)
  }

  async current() {
    await this.reconcile().catch(error => {
      if (!(error instanceof ClientError)) throw error
    })
    const [state, lines] = await Promise.all([
      this.store.readState(),
      this.store.readLog()
    ])
    return this.view(state, lines)
  }

  private view(state: RunState | null, lines: string[]) {
    if (!state) return { run: null, lines: [] as string[] }
    const end = state.finishedAt ? new Date(state.finishedAt) : this.now
    return {
      run: {
        runId: state.runId,
        key: state.key,
        title: this.titleOf(state.key),
        mode: state.mode,
        status: state.status,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        elapsedMs: Math.max(
          0,
          end.getTime() - new Date(state.startedAt).getTime()
        ),
        exitCode: state.exitCode,
        progress: state.progress,
        summary: state.summary
      },
      lines
    }
  }

  async cancel(reason = 'Cancelada pelo admin.') {
    const state = await this.store.readState()
    if (!state || state.status !== 'running') {
      throw new ClientError('Não há execução em andamento.', 409)
    }
    const active = this.active
    if (active && active.runId === state.runId) {
      active.cancelReason = reason
      this.terminate(active)
      return { cancelling: true }
    }
    if (state.pid !== null && this.isRunner(state.pid, state.key)) {
      process.kill(state.pid, 'SIGTERM')
      return { cancelling: true }
    }
    throw new ClientError('Não há execução em andamento.', 409)
  }

  private terminate(active: Active) {
    active.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (this.active === active) active.child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref?.()
    void active.done.then(() => clearTimeout(timer))
  }

  /** Encerramento da API: o filho não pode ficar órfão, e a linha de auditoria não pode ficar dizendo "iniciada". */
  async stopAll() {
    const active = this.active
    if (!active) return
    active.cancelReason = 'Interrompida: a API foi reiniciada.'
    this.terminate(active)
    await Promise.race([
      active.done,
      new Promise(resolve =>
        setTimeout(resolve, KILL_GRACE_MS + 2_000).unref?.()
      )
    ])
  }
}
