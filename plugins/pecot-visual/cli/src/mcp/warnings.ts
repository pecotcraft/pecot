// diagnostics の `warning: ` の行を文の配列にする。出力の捕捉の上限と別に保ち、早く出た warning を落とさない。

const WARNING_PREFIX = 'warning: '
const CONTINUATION_PREFIX = '  '

/**
保つ warning の件数の上限。超えた分は数えて、最後に知らせの 1 文を足す。
*/
export const WARNING_LIMIT_COUNT = 100

/**
保つ warning の文の合計の上限 (バイト)。出力の捕捉と同じ 64KB にする。
*/
export const WARNING_LIMIT_BYTES = 64 * 1024

export interface WarningCollector {
  /**
  改行を除いた 1 行を渡す。
  */
  addLine(line: string): void
  /**
  ここまでの warning の文。trailing は改行で終わっていない最後の行で、状態には残さない。
  */
  list(trailing?: string): string[]
}

class WarningState {
  private readonly kept: string[] = []
  private readonly seen = new Set<string>()
  private keptBytes = 0
  private omitted = 0
  /**
  組み立て中の warning の行。上限を超えた後の行は足さず、バイト数だけ数える。
  */
  private current: string[] | undefined
  private currentBytes = 0

  private append(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    // 1 つの warning が上限を超えたら、それ以上の行は持たない (閉じるときに省いた数へ入る)。
    if (this.currentBytes + bytes <= WARNING_LIMIT_BYTES) this.current?.push(text)
    this.currentBytes += bytes
  }

  private close(): void {
    const { current } = this
    if (current === undefined) return
    this.current = undefined
    const text = current.join('\n')
    if (text.trim() === '' || this.seen.has(text)) return
    if (this.kept.length >= WARNING_LIMIT_COUNT || this.keptBytes + this.currentBytes > WARNING_LIMIT_BYTES) {
      this.omitted += 1
      return
    }
    this.kept.push(text)
    this.seen.add(text)
    this.keptBytes += this.currentBytes
  }

  clone(): WarningState {
    const copy = new WarningState()
    copy.kept.push(...this.kept)
    for (const text of this.seen) copy.seen.add(text)
    copy.keptBytes = this.keptBytes
    copy.omitted = this.omitted
    copy.current = this.current === undefined ? undefined : [...this.current]
    copy.currentBytes = this.currentBytes
    return copy
  }

  addLine(line: string): void {
    if (line.startsWith(WARNING_PREFIX)) {
      this.close()
      this.current = []
      this.currentBytes = 0
      this.append(line.slice(WARNING_PREFIX.length))
    }
    else if (this.current !== undefined && line.startsWith(CONTINUATION_PREFIX)) {
      this.append(line.slice(CONTINUATION_PREFIX.length))
    }
    else {
      this.close()
    }
  }

  finish(): string[] {
    this.close()
    return this.omitted > 0 ? [...this.kept, omittedNotice(this.omitted)] : [...this.kept]
  }
}

function omittedNotice(count: number): string {
  return `${String(count)} more warnings were omitted (limit: ${String(WARNING_LIMIT_COUNT)} warnings or ${String(WARNING_LIMIT_BYTES)} bytes)`
}

export function createWarningCollector(): WarningCollector {
  const state = new WarningState()
  return {
    addLine: (line) => {
      state.addLine(line)
    },
    list: (trailing) => {
      const snapshot = state.clone()
      if (trailing !== undefined) snapshot.addLine(trailing)
      return snapshot.finish()
    },
  }
}

/**
文字列の全体から warning の文を取る。続きの行 (先頭に空白 2 つ) は同じ文に含める。
*/
export function warningsOf(text: string): string[] {
  const collector = createWarningCollector()
  for (const line of text.split('\n')) collector.addLine(line)
  return collector.list()
}
