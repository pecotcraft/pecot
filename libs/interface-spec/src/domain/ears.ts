import type { Pattern } from './schema.js'

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

export function hasJapanese(text: string): boolean {
  return JAPANESE.test(text)
}

// 最初の区切り（と、・間、・なら、）までの前置きで型を決める。応答の側の区切りは見ない。
function firstClause(statement: string): { readonly lead: string, readonly delimiter: string } | undefined {
  const match = /^(?<lead>.+?)(?<delimiter>と、|間、|なら、).+$/su.exec(statement)
  const { lead, delimiter } = match?.groups ?? {}
  return lead === undefined || delimiter === undefined ? undefined : { lead, delimiter }
}

const FORMS: Readonly<Record<Pattern, (statement: string) => boolean>> = {
  ubiquitous: statement => statement.startsWith('常に、') && statement.length > '常に、'.length,
  event: statement => !statement.startsWith('もし') && !statement.startsWith('常に、') && firstClause(statement)?.delimiter === 'と、',
  state: statement => !statement.startsWith('もし') && firstClause(statement)?.delimiter === '間、',
  unwanted: statement => /^もし.+なら、.+$/su.test(statement),
  optional: statement => !statement.startsWith('もし') && firstClause(statement)?.delimiter === 'なら、' && firstClause(statement)?.lead.endsWith('が有効') === true,
}

export function isPatternMatch(pattern: Pattern, statement: string): boolean {
  return FORMS[pattern](statement)
}
