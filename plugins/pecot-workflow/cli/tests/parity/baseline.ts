// 移行前の基準値 baseline.json の読み込み。vitest.config.ts の閾値と parity テストが共有する。
// JSON は unknown から型ガードで絞り、形が崩れていれば読み込みの時点で落とす。
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface Baseline {
  readonly measuredAt: string
  readonly commit: string
  readonly cli: Readonly<{ lineCoverage: number }>
  readonly hooks: Readonly<{ testCount: number, scripts: readonly string[] }>
}

export const baselinePath = path.join(import.meta.dirname, 'baseline.json')

/**
UTF-16 コード単位順で文字列を比べる。Array#sort() の既定と同じ順で、実行環境のロケールに左右されない。
*/
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function assertExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).toSorted(compareStrings)
  const wanted = expected.toSorted(compareStrings)
  if (actual.join(',') !== wanted.join(',')) {
    throw new TypeError(`baseline.json: ${label} のキーが想定と違います (実際: ${actual.join(', ')} / 想定: ${wanted.join(', ')})`)
  }
}

export function readBaseline(): Baseline {
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (!isRecord(parsed)) throw new TypeError('baseline.json: ルートがオブジェクトではありません')
  assertExactKeys(parsed, ['measuredAt', 'commit', 'cli', 'hooks'], 'ルート')
  const { measuredAt, commit, cli, hooks } = parsed
  if (typeof measuredAt !== 'string') throw new TypeError('baseline.json: measuredAt が文字列ではありません')
  if (typeof commit !== 'string') throw new TypeError('baseline.json: commit が文字列ではありません')
  if (!isRecord(cli) || typeof cli['lineCoverage'] !== 'number') throw new TypeError('baseline.json: cli.lineCoverage が数値ではありません')
  assertExactKeys(cli, ['lineCoverage'], 'cli')
  if (!isRecord(hooks) || typeof hooks['testCount'] !== 'number' || !isStringArray(hooks['scripts'])) {
    throw new TypeError('baseline.json: hooks.testCount が数値でない、または hooks.scripts が文字列の配列ではありません')
  }
  assertExactKeys(hooks, ['testCount', 'scripts'], 'hooks')
  return {
    measuredAt,
    commit,
    cli: { lineCoverage: cli['lineCoverage'] },
    hooks: { testCount: hooks['testCount'], scripts: hooks['scripts'] },
  }
}
