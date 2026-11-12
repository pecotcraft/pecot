/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
// 一時ディレクトリの補助。
//
// 使い方:
//   const directory = makeTemporaryDirectory()
//     realpath 済みの空ディレクトリを作る。テストの後に自動で消える。
//   writeTree(directory, { 'a/b.txt': 'x' })
//     相対パスと内容の対でファイルを書く。
// 後始末は、このファイルを import したテストファイルの afterEach が行う。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach } from 'vitest'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

export function makeTemporaryDirectory(prefix = 'pecot-cli-'): string {
  const fresh = mkdtempSync(path.join(tmpdir(), prefix))
  const directory = realpathSync(fresh)
  created.push(directory)
  return directory
}

export function writeTree(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}
