// 各プラグインの generated.json が書き出しと一致するかの確認が使う。
import type { GeneratedFile } from './schema.js'
import { compareText, isRecord } from './utility.js'

type Emit = (path: string, change: string) => void

function compareRecords(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>, path: string, emit: Emit): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted(compareText)
  for (const key of keys) {
    const child = path === '' ? key : `${path}.${key}`
    if (Object.hasOwn(before, key) && Object.hasOwn(after, key)) compare(before[key], after[key], child, emit)
    else emit(child, Object.hasOwn(after, key) ? 'added' : 'removed')
  }
}

function compareArrays(before: readonly unknown[], after: readonly unknown[], path: string, emit: Emit): void {
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const child = `${path}[${String(index)}]`
    if (index >= before.length) emit(child, 'added')
    else if (index >= after.length) emit(child, 'removed')
    else compare(before[index], after[index], child, emit)
  }
}

function compare(before: unknown, after: unknown, path: string, emit: Emit): void {
  if (isRecord(before) && isRecord(after)) compareRecords(before, after, path, emit)
  else if (Array.isArray(before) && Array.isArray(after)) compareArrays(before, after, path, emit)
  else if (JSON.stringify(before) !== JSON.stringify(after)) emit(path, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
}

// 2 つの generated.json の差を「項目の ID: 欄のパス: 変わり方」の行にする。項目が丸ごと増減したときの欄は entry。
export function diffGenerated(before: Readonly<GeneratedFile>, after: Readonly<GeneratedFile>): string[] {
  const lines: string[] = []
  for (const key of ['format', 'plugin', 'prefix', 'names'] as const) {
    compare(before[key], after[key], key, (path, change) => {
      lines.push(`file: ${path}: ${change}`)
    })
  }
  const beforeById = new Map(before.entries.map(entry => [entry.id, entry]))
  const afterById = new Map(after.entries.map(entry => [entry.id, entry]))
  for (const id of [...new Set([...beforeById.keys(), ...afterById.keys()])].toSorted(compareText)) {
    const old = beforeById.get(id)
    const next = afterById.get(id)
    if (old === undefined || next === undefined) {
      lines.push(`${id}: entry: ${old === undefined ? 'added' : 'removed'}`)
      continue
    }
    compare(old, next, '', (path, change) => {
      lines.push(`${id}: ${path}: ${change}`)
    })
  }
  return lines
}

// 書き出しが古いときの失敗の行。1 行目は error、差の行は 2 空白で字下げ、最後に直すコマンド。
export function formatStale(file: string, lines: readonly string[], command: string): string[] {
  return [`error: ${file} is stale`, ...lines.map(line => `  ${line}`), `  run: ${command}`]
}
