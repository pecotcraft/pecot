// 旧い形（進行の欄の名前は pecot-workflow-<suffix>、設定ファイルの名前は <host>_<owner>_<slug>_<suffix>.json）から移す予定を決める。
import { LEGACY_WORKFLOW_FIELD_PREFIX, WORKFLOW_FIELD_NAME, projectConfigFileName } from './config.js'
import { compareStrings } from './python-format.js'

/**
進行の欄の扱い。use は使うフィールドの名前（create なら作る名前）。legacy は残っている旧い名前のフィールド
*/
export type WorkflowFieldPlan
  = | { readonly kind: 'current', readonly use: string }
    | { readonly kind: 'rename', readonly use: string, readonly from: string }
    | { readonly kind: 'both', readonly use: string, readonly legacy: string }
    | { readonly kind: 'create', readonly use: string }

export function isLegacyWorkflowFieldName(name: string): boolean {
  return name.startsWith(LEGACY_WORKFLOW_FIELD_PREFIX) && name.length > LEGACY_WORKFLOW_FIELD_PREFIX.length
}

/**
フィールドの名前の一覧から、進行の欄の扱いを決める。旧い名前が複数あれば最初のものを使う
*/
export function planWorkflowField(fieldNames: readonly string[]): WorkflowFieldPlan {
  const hasCurrent = fieldNames.includes(WORKFLOW_FIELD_NAME)
  const legacy = fieldNames.find(name => isLegacyWorkflowFieldName(name))
  if (hasCurrent) return legacy === undefined ? { kind: 'current', use: WORKFLOW_FIELD_NAME } : { kind: 'both', use: WORKFLOW_FIELD_NAME, legacy }
  return legacy === undefined ? { kind: 'create', use: WORKFLOW_FIELD_NAME } : { kind: 'rename', use: WORKFLOW_FIELD_NAME, from: legacy }
}

/**
設定ファイルの名前と、中身が指すボード
*/
export interface ConfigFileEntry {
  readonly fileName: string
  readonly host: string
  readonly owner: string
  readonly number: number
}

export interface BoardIdentity {
  readonly host: string
  readonly owner: string
  readonly number: number
}

/**
同じボードを指す、新しい名前と違う設定ファイル（名前順）。2 つ以上なら、移す元が決まらない
*/
export function planConfigMove(target: Readonly<BoardIdentity>, files: readonly ConfigFileEntry[]): { readonly to: string, readonly from: readonly string[] } {
  const to = projectConfigFileName(target.host, target.owner, target.number)
  const from = files
    .filter(file => file.fileName !== to && file.host === target.host && file.owner === target.owner && file.number === target.number)
    .map(file => file.fileName)
    .toSorted(compareStrings)
  return { to, from }
}
