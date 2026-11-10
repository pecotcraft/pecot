import type { Pattern } from './schema.js'

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

export function hasJapanese(text: string): boolean {
  return JAPANESE.test(text)
}

const FORMS: Readonly<Record<Pattern, (statement: string) => boolean>> = {
  ubiquitous: statement => statement.startsWith('常に、') && statement.length > '常に、'.length,
  event: statement => !statement.startsWith('もし') && !statement.startsWith('常に、')
    && !statement.includes('間、') && !statement.includes('が有効なら、')
    && /^.+と、.+$/su.test(statement),
  state: statement => /^.+間、.+$/su.test(statement),
  unwanted: statement => /^もし.+なら、.+$/su.test(statement),
  optional: statement => !statement.startsWith('もし') && /^.+が有効なら、.+$/su.test(statement),
}

export function isPatternMatch(pattern: Pattern, statement: string): boolean {
  return FORMS[pattern](statement)
}
