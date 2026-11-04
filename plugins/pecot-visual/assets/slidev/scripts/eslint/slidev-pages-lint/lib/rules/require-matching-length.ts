import type { Rule } from 'eslint';
import {
  parseFrontmatter,
  readThemeSettings,
  loadLayoutReference,
  getLayoutPropTree,
  collectMatchingLengthDeclarations,
  resolveFieldValues,
} from '@v-slidev/eslint-shared';
import type { FrontmatterBase } from '@v-slidev/eslint-shared';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require array props declared with same_length_as in the layout reference to have matching element counts',
      recommended: true,
    },
    schema: [],
    messages: {
      lengthMismatch:
        "'{{path}}'（{{pathCount}} 件）と '{{target}}'（{{targetCount}} 件）の件数が一致しません。同じ件数・同じ順で対応させてください。",
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const frontmatter = parseFrontmatter(text) as FrontmatterBase | null;
      if (!frontmatter || !frontmatter.layout) {
        return;
      }

      const { referencesDirectories } = readThemeSettings(context);
      if (referencesDirectories.length === 0) {
        return;
      }

      const layoutName = frontmatter.layout;
      const reference = loadLayoutReference(referencesDirectories, layoutName);
      if (!reference) {
        return;
      }

      const tree = getLayoutPropTree(reference, referencesDirectories);
      const declarations = collectMatchingLengthDeclarations(tree);

      for (const declaration of declarations) {
        const frontmatterRecord = frontmatter as unknown as Record<string, unknown>;
        const source = resolveFieldValues(frontmatterRecord, declaration.path);
        const target = resolveFieldValues(frontmatterRecord, declaration.target);

        // 両方が配列として解決できたときだけ判定する。片方が欠落・非配列の場合は
        // 既存の required の確認（no-unknown-props 等）に任せる。
        if (source.length !== 1 || target.length !== 1) {
          continue;
        }
        const sourceValue = source[0].value;
        const targetValue = target[0].value;
        if (!Array.isArray(sourceValue) || !Array.isArray(targetValue)) {
          continue;
        }
        if (sourceValue.length === targetValue.length) {
          continue;
        }

        context.report({
          node,
          messageId: 'lengthMismatch',
          data: {
            path: declaration.path,
            pathCount: String(sourceValue.length),
            target: declaration.target,
            targetCount: String(targetValue.length),
          },
        });
      }
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
