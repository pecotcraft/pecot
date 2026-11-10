import type { Rule } from 'eslint';
import { loadConstraintsFor, expandStringTargets } from '../utils/constraint-loader.ts';
import { resolveFieldValues, stripHtmlTags } from '@v-slidev/eslint-shared';
import { lintText } from '../textlint/client.ts';
import type { TextFinding } from '@pecot/text-rules';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Check display text of fields listed in text_constraints with textlint (AI-style phrasing, redundant expressions, NG words)',
      recommended: true,
    },
    schema: [],
    messages: {
      textlint: '{{fieldPath}}: {{message}} ({{ruleId}})',
      textlintFailed: '{{fieldPath}}: textlint failed to run: {{reason}}',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const loaded = loadConstraintsFor(context);
      if (!loaded) {
        return;
      }
      const { frontmatter, constraints } = loaded;

      // `items[]` と `items[].caption` のように宣言が重なる項目は 1 度だけ確認する
      const checkedPaths = new Set<string>();

      for (const fieldPath of Object.keys(constraints)) {
        for (const { value, path } of resolveFieldValues(frontmatter, fieldPath)) {
          for (const target of expandStringTargets(value, path || fieldPath)) {
            if (checkedPaths.has(target.path)) {
              continue;
            }
            checkedPaths.add(target.path);
            // HTML タグ（強調の <strong> 等）を除いて textlint に渡す
            const plain = stripHtmlTags(target.text).trim();
            // 空の項目は max-chars が emptyText で報告するため、ここでは扱わない
            if (plain === '') {
              continue;
            }
            let findings: readonly TextFinding[];
            try {
              findings = lintText(plain);
            } catch (error) {
              // worker の起動失敗・textlint の例外で ESLint 全体を落とさず、該当項目の報告にする
              context.report({
                node,
                messageId: 'textlintFailed',
                data: {
                  fieldPath: target.path,
                  reason: error instanceof Error ? error.message : String(error),
                },
              });
              continue;
            }
            for (const finding of findings) {
              context.report({
                node,
                messageId: 'textlint',
                data: { fieldPath: target.path, message: finding.message, ruleId: finding.ruleId },
              });
            }
          }
        }
      }
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
