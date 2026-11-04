// process.stderr への書き込みを捕まえる。警告・エラーの出力を確かめるテストで使う（stderr は I/O 境界）。
// 後始末は、このファイルを import したテストファイルの afterEach が行う。
import { afterEach, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

export interface CapturedStderr {
  /**
  これまでに書かれた stderr の全文
  */
  readonly text: () => string
}

export function captureStderr(): CapturedStderr {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  return { text: () => written.join('') }
}
