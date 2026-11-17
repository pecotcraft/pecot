// vitest の setupFiles。1 つのファイルの中で、JUnit の name（describe から it までの題を ` > ` でつないだもの）が重なれば止める。
// 重なると、定義書のサイトのビルドが sphinx-test-reports の重複の警告で落ちる（.claude/rules/test-conventions.md）。
import { beforeAll } from 'vitest'
import type { RunnerTestFile } from 'vitest'

interface TaskNode {
  readonly type: string
  readonly name: string
  readonly tasks?: readonly TaskNode[]
}

// 重なった名前を、出た順に 1 つずつ返す。
export function duplicateTitles(file: { readonly tasks: readonly TaskNode[] }): string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  const walk = (tasks: readonly TaskNode[], prefix: readonly string[]): void => {
    for (const task of tasks) {
      const names = [...prefix, task.name]
      if (task.type === 'suite') {
        walk(task.tasks ?? [], names)
        continue
      }
      const full = names.join(' > ')
      if (seen.has(full)) duplicated.add(full)
      seen.add(full)
    }
  }
  walk(file.tasks, [])
  return [...duplicated]
}

function isFile(task: unknown): task is RunnerTestFile {
  return typeof task === 'object' && task !== null && 'filepath' in task
}

// vitest は第 1 引数を fixture として読み、分割代入でないと止まる。
// eslint-disable-next-line no-empty-pattern -- 使う fixture が無いので空にする
beforeAll(({}, suite) => {
  if (!isFile(suite)) return
  const duplicated = duplicateTitles(suite)
  if (duplicated.length === 0) return
  throw new Error(`同じ題のテストが重なる（.claude/rules/test-conventions.md）:\n${duplicated.map(name => `  ${name}`).join('\n')}`)
})
