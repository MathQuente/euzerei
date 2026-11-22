const SECRET_PARAM =
  /\b(client_secret|client_id|access_token|refresh_token|api_key|apikey|password|secret|token)=[^&\s"']+/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const URL_CREDENTIALS = /\/\/[^\s/@:]+:[^\s/@]+@/g

export const LOG_LINE_MAX = 300

/** A saída dos scripts vai para o Redis e para a auditoria: nada que pareça segredo passa. */
export function redactLogLine(line: string): string {
  return line
    .replace(SECRET_PARAM, '$1=…')
    .replace(BEARER, 'Bearer …')
    .replace(URL_CREDENTIALS, '//…@')
    .trim()
    .slice(0, LOG_LINE_MAX)
}

/** Separa a saída em linhas completas (\n) e em atualizações de progresso (\r ou sem fim de linha ainda). */
export class LineSplitter {
  private buffer = ''

  constructor(
    private onLine: (line: string) => void,
    private onProgress: (line: string) => void
  ) {}

  feed(chunk: string) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.search(/[\r\n]/)
      if (index < 0) break
      const delimiter = this.buffer[index]
      const text = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!text.trim()) continue
      if (delimiter === '\n') this.onLine(text)
      else this.onProgress(text)
    }
    if (this.buffer.trim()) this.onProgress(this.buffer)
  }

  /** O processo terminou: o que sobrou vira uma linha. */
  end() {
    if (this.buffer.trim()) this.onLine(this.buffer)
    this.buffer = ''
  }
}
