import type { Rule } from 'eslint';
import { loadConstraintsFor, expandStringTargets } from '../utils/constraint-loader.ts';
import {
  resolveFieldValues,
  validateText,
  hasBoldEmphasis,
  BOLD_REQUIRED_MESSAGE,
  hasDisallowedEmTag,
  EM_DISALLOWED_MESSAGE,
} from '@v-slidev/eslint-shared';

function reportItemCount(
  context: Rule.RuleContext,
  node: Rule.Node,
  messageId: 'minItems' | 'maxItems',
  fieldPath: string,
  actual: number,
  limit: number,
  note: string | undefined,
): void {
  context.report({
    node,
    messageId,
    data: {
      fieldPath,
      actual: String(actual),
      limit: String(limit),
      note: note ? `。${note}` : '',
    },
  });
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce text constraints (min_chars, max_chars, min_items, max_items, bold_required) defined in layout reference YAML',
      recommended: true,
    },
    schema: [],
    messages: {
      minChars: '{{fieldPath}}: {{detail}}（HTMLタグ除去後の全角換算の文字数）',
      maxChars: '{{fieldPath}}: {{detail}}（HTMLタグ除去後の全角換算の文字数）',
      minItems: '{{fieldPath}}: 配列要素数が{{actual}}です（最小{{limit}}）{{note}}',
      maxItems: '{{fieldPath}}: 配列要素数が{{actual}}です（最大{{limit}}）{{note}}',
      emptyText:
        '{{fieldPath}}: テキストが空です（値を設定するか、フィールドを削除してください）',
      boldRequired: `{{fieldPath}}: ${BOLD_REQUIRED_MESSAGE}`,
      emDisallowed: `{{fieldPath}}: ${EM_DISALLOWED_MESSAGE}`,
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const loaded = loadConstraintsFor(context);
      if (!loaded) {
        return;
      }
      const { frontmatter, constraints } = loaded;
      if (Object.keys(constraints).length === 0) {
        return;
      }

      for (const [fieldPath, constraintRaw] of Object.entries(constraints)) {
        const constraint = constraintRaw;

        const resolved = resolveFieldValues(frontmatter, fieldPath);

        // 件数判定は resolved が空のときの continue より前に行う
        const countTargets =
          resolved.length === 0 && !fieldPath.includes('[]')
            ? [{ value: [] as unknown[], path: fieldPath }]
            : resolved;
        for (const { value, path } of countTargets) {
          if (!Array.isArray(value)) {
            continue;
          }
          const displayPath = path || fieldPath;
          if (constraint.min_items != null && value.length < constraint.min_items) {
            reportItemCount(context, node, 'minItems', displayPath, value.length, constraint.min_items, constraint.note);
          }
          if (constraint.max_items != null && value.length > constraint.max_items) {
            reportItemCount(context, node, 'maxItems', displayPath, value.length, constraint.max_items, constraint.note);
          }
        }

        if (resolved.length === 0) {
          continue;
        }

        for (const { value, path } of resolved) {
          const displayPath = path || fieldPath;

          if (value === null || (typeof value === 'string' && value.trim() === '')) {
            context.report({
              node,
              messageId: 'emptyText',
              data: { fieldPath: displayPath },
            });
            continue;
          }

          if (typeof value !== 'string') {
            // [] の付かないパスに配列が来た場合、要素ごとに検証する
            // （min_chars / max_chars は従来どおり配列値をスキップする）
            if (Array.isArray(value)) {
              for (const element of expandStringTargets(value, displayPath)) {
                if (element.text.trim() === '') {
                  continue;
                }
                if (constraint.bold_required === true && !hasBoldEmphasis(element.text)) {
                  context.report({
                    node,
                    messageId: 'boldRequired',
                    data: { fieldPath: element.path },
                  });
                }
                if (hasDisallowedEmTag(element.text)) {
                  context.report({
                    node,
                    messageId: 'emDisallowed',
                    data: { fieldPath: element.path },
                  });
                }
              }
            }
            continue;
          }

          const errors = validateText(value, constraint);
          for (const error of errors) {
            const messageId = error.type === 'minChars' ? 'minChars' : 'maxChars';
            context.report({
              node,
              messageId,
              data: {
                fieldPath: displayPath,
                detail: error.message,
              },
            });
          }

          if (constraint.bold_required === true && !hasBoldEmphasis(value)) {
            context.report({
              node,
              messageId: 'boldRequired',
              data: { fieldPath: displayPath },
            });
          }

          if (hasDisallowedEmTag(value)) {
            context.report({
              node,
              messageId: 'emDisallowed',
              data: { fieldPath: displayPath },
            });
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
