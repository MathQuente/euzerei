import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CATALOG_JOBS } from './admin-catalog-jobs'
import { backupDir, resolveRunCommand, tsxLoader } from './catalog-run-command'

const job = CATALOG_JOBS.find(j => j.key === 'slugs')!

describe('resolveRunCommand', () => {
  it('com CATALOG_SCRIPTS_DIR roda o script de lá, nunca o real', () => {
    const cmd = resolveRunCommand(job, ['--apply'], {
      CATALOG_SCRIPTS_DIR: '/stubs'
    })

    expect(cmd.command).toBe(process.execPath)
    expect(cmd.args).toEqual([join('/stubs', 'backfill-slugs.js'), '--apply'])
    expect(cmd.args.join(' ')).not.toContain('src/scripts')
  })

  it('sem override aponta para src/scripts (tsx) ou dist/scripts, com o argumento recebido', () => {
    const cmd = resolveRunCommand(job, ['--apply'], {})

    expect(cmd.args.at(-1)).toBe('--apply')
    expect(
      cmd.args.some(a => /scripts[\\/]backfill-slugs\.(ts|js)$/.test(a))
    ).toBe(true)
  })

  it('em desenvolvimento o loader do tsx vai como URL absoluta e funciona a partir de outra pasta (sem node_modules)', () => {
    const cmd = resolveRunCommand(job, [], {})

    expect(cmd.args[0]).toBe('--import')
    expect(cmd.args[1]).toMatch(/^file:\/\/\//)
    expect(cmd.args[1]).toBe(tsxLoader())
    // O filho roda no diretório de backup; sem isso `--import tsx` solto falha com ERR_MODULE_NOT_FOUND.
    const probe = spawnSync(
      process.execPath,
      ['--import', tsxLoader(), '-e', 'console.log("tsx ok")'],
      {
        cwd: cmd.cwd,
        encoding: 'utf8'
      }
    )
    expect(probe.stdout.trim()).toBe('tsx ok')
    expect(probe.status).toBe(0)
  })

  it('o diretório de backup padrão fica no tmp e CATALOG_BACKUP_DIR manda', () => {
    expect(backupDir({})).toBe(join(tmpdir(), 'euzerei-catalog'))
    const custom = join(tmpdir(), 'euzerei-catalog-teste')
    expect(backupDir({ CATALOG_BACKUP_DIR: custom })).toBe(custom)
  })

  it('todo job tem arquivo e flags explícitas', () => {
    for (const j of CATALOG_JOBS) {
      expect(j.file).toMatch(/^[a-z-]+$/)
      expect(Array.isArray(j.applyArgs)).toBe(true)
    }
    // Nenhum job pode gravar sem querer: cover-urls, sync, hypes e modes simulam com --dry-run; os outros com o padrão.
    const dry = Object.fromEntries(CATALOG_JOBS.map(j => [j.key, j.dryArgs]))
    expect(dry.covers).toEqual(['--dry-run'])
    expect(dry.sync).toEqual(['--dry-run'])
    expect(dry.hypes).toEqual(['--dry-run'])
    expect(dry.modes).toEqual(['--dry-run'])
    expect(CATALOG_JOBS.find(j => j.key === 'endless')!.applyArgs).toEqual([
      '--apply'
    ])
    expect(CATALOG_JOBS.find(j => j.key === 'precision')!.applyArgs).toEqual([
      '--apply'
    ])
  })
})
