// 機能の値の検証で止めた理由を、チェックの problem の文にする
import type { AttributeError } from '@pecot/workflow-core/domain/attributes.js'

/**
error の行の文。似た名前・取りうる値・代わりの操作を後ろに付ける
*/
export function attributeErrorLine(error: Readonly<AttributeError>): string {
  const where = error.source === undefined ? error.name : `${error.name} (${error.source})`
  const parts = [`${error.code}: ${where}`]
  if (error.value !== undefined) parts.push(`value ${error.value === null ? 'null' : JSON.stringify(error.value)}`)
  if (error.expected !== undefined) parts.push(`expected ${error.expected}`)
  if (error.candidates !== undefined && error.candidates.length > 0) parts.push(`did you mean ${error.candidates.join(', ')}`)
  if (error.sources !== undefined && error.sources.length > 0) parts.push(`give source: ${error.sources.join(' or ')}`)
  if (error.hint !== undefined) parts.push(error.hint)
  return parts.join('; ')
}
