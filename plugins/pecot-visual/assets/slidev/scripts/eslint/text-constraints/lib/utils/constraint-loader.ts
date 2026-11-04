import type { Rule } from 'eslint';
import { readThemeSettings, loadLayoutReference, parseFrontmatter } from '@v-slidev/eslint-shared';
import type { FrontmatterBase, TextConstraint } from '@v-slidev/eslint-shared';

export { readThemeSettings, loadLayoutReference, parseFrontmatter };

export interface TextConstraintsMap {
  [fieldPath: string]: TextConstraint;
}

export function getTextConstraints(
  reference: Record<string, unknown> | null | undefined,
  referencesDirectories: readonly string[] = [],
  _visited: Set<string> = new Set(),
): TextConstraintsMap {
  const constraints: TextConstraintsMap = {};

  const includes: unknown = reference?.includes;
  if (Array.isArray(includes) && referencesDirectories.length > 0) {
    for (const name of includes as unknown[]) {
      if (typeof name !== 'string') continue;
      if (_visited.has(name)) {
        continue;
      }
      _visited.add(name);
      const shared = loadLayoutReference(referencesDirectories, name);
      const sharedConstraints = shared?.text_constraints;
      if (sharedConstraints && typeof sharedConstraints === 'object') {
        Object.assign(constraints, sharedConstraints);
      }
    }
  }

  const refConstraints = reference?.text_constraints;
  if (refConstraints && typeof refConstraints === 'object') {
    Object.assign(constraints, refConstraints);
  }

  return constraints;
}

export interface LoadedConstraints {
  frontmatter: FrontmatterBase;
  constraints: TextConstraintsMap;
}

// lint 対象のファイルから frontmatter とその layout の text_constraints を読む。
// frontmatter・layout・参照 YAML のどれかが無ければ、lint 対象外として null を返す。
export function loadConstraintsFor(context: Rule.RuleContext): LoadedConstraints | null {
  const sourceCode = context.sourceCode;
  let text: string;
  try {
    text = sourceCode.getText();
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(text) as FrontmatterBase | null;
  if (!frontmatter || !frontmatter.layout) {
    return null;
  }

  const { referencesDirectories } = readThemeSettings(context);
  if (referencesDirectories.length === 0) {
    return null;
  }

  const reference = loadLayoutReference(referencesDirectories, frontmatter.layout);
  if (!reference) {
    return null;
  }

  return { frontmatter, constraints: getTextConstraints(reference, referencesDirectories) };
}

export interface StringTarget {
  text: string;
  path: string;
}

// 文字列は 1 件、配列は文字列の要素ごとに添字付きのパスで展開する（文字列以外は対象外）
export function expandStringTargets(value: unknown, displayPath: string): StringTarget[] {
  if (typeof value === 'string') {
    return [{ text: value, path: displayPath }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const targets: StringTarget[] = [];
  value.forEach((element: unknown, index: number) => {
    if (typeof element === 'string') {
      targets.push({ text: element, path: `${displayPath}[${index}]` });
    }
  });
  return targets;
}
