// `?raw` の付いた import をファイルの文字列にする。vitest（vite）の `?raw` と同じ扱いを rollup でも行う。
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SUFFIX = '?raw'

export function rawText() {
  return {
    name: 'pecot-raw-text',
    resolveId(source, importer) {
      if (importer !== undefined && source.endsWith(SUFFIX)) return `${path.resolve(path.dirname(importer), source.slice(0, -SUFFIX.length))}${SUFFIX}`
    },
    load(id) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのは src の中から import した雛形だけ
      if (id.endsWith(SUFFIX)) return `export default ${JSON.stringify(readFileSync(id.slice(0, -SUFFIX.length), 'utf8'))}`
    },
  }
}
