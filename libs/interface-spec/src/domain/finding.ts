import { compareText } from './utility.js'

export { compareText } from './utility.js'

export interface Finding {
  readonly file: string
  // ソースの行番号。file に :行 を付けて出す。
  readonly line?: number
  readonly scope?: string
  readonly field?: string
  readonly reason: string
}

export function formatFinding(finding: Finding): string {
  const file = finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`
  return ['error', file, finding.scope, finding.field, finding.reason]
    .filter(part => part !== undefined)
    .join(': ')
}

// ファイル・項目の ID・欄・理由の順に並べ、同じ入力からいつも同じ行の並びを出す。
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.toSorted((left, right) =>
    compareText(left.file, right.file)
    || (left.line ?? 0) - (right.line ?? 0)
    || compareText(left.scope ?? '', right.scope ?? '')
    || compareText(left.field ?? '', right.field ?? '')
    || compareText(left.reason, right.reason))
}
