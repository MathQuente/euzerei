import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const readProcCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return null
  }
}

/**
 * O pid está vivo E é o script do job? Depois de um reinício (ou num contêiner, cujo espaço de pids recomeça) o número
 * guardado no Redis pode pertencer a outro processo, até à própria API: nunca se mata nem se espera por um pid só
 * porque ele existe. Sem /proc (fora do Linux) só dá para saber que está vivo.
 */
export function pidRunsScript(
  pid: number,
  scriptFile: string,
  readCmdline: (pid: number) => string | null = readProcCmdline
): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const cmdline = readCmdline(pid)
  if (cmdline === null) return true
  return cmdline
    .split('\0')
    .some(arg => basename(arg).replace(/\.(js|ts)$/, '') === scriptFile)
}
