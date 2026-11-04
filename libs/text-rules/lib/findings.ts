// ai-tech-writing-guideline の件数要約は個別指摘の重複なので除く
export const SUMMARY_PREFIX = '【テクニカルライティング品質分析】'

// message 内の改行は 1 行にまとめる
export function oneLine(message: string): string {
  return message.replaceAll(/\s*\n\s*/g, ' ').trim()
}

// 件数要約の message を除き、個別の指摘だけ残す。
export function withoutSummary<T extends { readonly message: string }>(messages: readonly T[]): T[] {
  return messages.filter(found => !found.message.startsWith(SUMMARY_PREFIX))
}
