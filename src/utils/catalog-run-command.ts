import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CatalogJobDefinition } from './admin-catalog-jobs'

export interface RunCommand {
  command: string
  args: string[]
  cwd: string
}

type Env = Record<string, string | undefined>

/** Onde o script grava os backups que cria (release-precision e cover-urls usam o diretório atual). */
export function backupDir(env: Env = process.env): string {
  const dir = env.CATALOG_BACKUP_DIR || join(tmpdir(), 'euzerei-catalog')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * O filho roda com o diretório de backup como cwd, onde não há node_modules: um `--import tsx` solto não resolveria
 * (o especificador é procurado a partir do cwd). Por isso o loader vai como URL de arquivo absoluta.
 */
export function tsxLoader(): string {
  return pathToFileURL(require.resolve('tsx')).href
}

/**
 * Como rodar o script de um job:
 * - CATALOG_SCRIPTS_DIR (testes): `<dir>/<arquivo>.js`, no lugar dos scripts reais;
 * - compilado (dist): `dist/scripts/<arquivo>.js`;
 * - desenvolvimento (tsx): `src/scripts/<arquivo>.ts`.
 * A saída é sempre o `node` atual, sem shell: nenhum valor do pedido entra na linha de comando.
 */
export function resolveRunCommand(
  job: CatalogJobDefinition,
  extraArgs: readonly string[],
  env: Env = process.env
): RunCommand {
  const cwd = backupDir(env)
  const overrideDir = env.CATALOG_SCRIPTS_DIR
  if (overrideDir) {
    return {
      command: process.execPath,
      args: [join(overrideDir, `${job.file}.js`), ...extraArgs],
      cwd
    }
  }

  const scriptsDir = join(__dirname, '..', 'scripts')
  if (__filename.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [
        '--import',
        tsxLoader(),
        join(scriptsDir, `${job.file}.ts`),
        ...extraArgs
      ],
      cwd
    }
  }
  return {
    command: process.execPath,
    args: [join(scriptsDir, `${job.file}.js`), ...extraArgs],
    cwd
  }
}
