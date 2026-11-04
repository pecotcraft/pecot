import type { Rule } from 'eslint';
import path from 'path';

// ESLint 10 の RuleContext は filename を常に持つ。
export function resolveFilename(context: Rule.RuleContext): string {
  return context.filename;
}

// pages/_references/ 配下はレイアウト定義用で、ページ規約の対象外。
export function isReferenceFile(filePath: string): boolean {
  return path.normalize(filePath).includes(path.sep + '_references' + path.sep);
}
