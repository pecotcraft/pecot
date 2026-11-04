import type { Rule } from 'eslint';
import { parseFrontmatter, readThemeSettings, loadLayoutReference, getLayoutPropTree } from '@v-slidev/eslint-shared';
import type { FrontmatterBase } from '@v-slidev/eslint-shared';
import { collectUnknownProps } from '../utils/prop-tree-walker.ts';

// @see node_modules/@slidev/types/dist/index.d.mts Frontmatter interface
export const SLIDEV_STANDARD_KEYS = new Set([
  'layout',
  'class',
  'clicks',
  'clicksStart',
  'preload',
  'hide',
  'disabled',
  'hideInToc',
  'title',
  'level',
  'routeAlias',
  'zoom',
  'dragPos',
  'src',
  'transition',
]);

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow frontmatter properties not defined in layout reference YAML',
      recommended: true,
    },
    schema: [],
    messages: {
      unknownProp:
        "'{{prop}}' は {{layout}} レイアウトで定義されていないプロパティです。使用可能: {{allowed}}",
      unknownNestedProp:
        "'{{path}}' は {{layout}} レイアウトで定義されていないキーです。使用可能: {{allowed}}",
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
      const findings = collectUnknownProps(frontmatter, tree, SLIDEV_STANDARD_KEYS);

      for (const finding of findings) {
        const allowed = finding.allowed.length > 0 ? finding.allowed.join(', ') : '(なし)';
        // ネスト配下の finding のみ unknownNestedProp で report する。
        // 走査時に確定させた isNested を使う（path 文字列の解析はしない）。
        if (finding.isNested) {
          context.report({
            node,
            messageId: 'unknownNestedProp',
            data: {
              path: finding.path,
              layout: layoutName,
              allowed,
            },
          });
        } else {
          context.report({
            node,
            messageId: 'unknownProp',
            data: {
              prop: finding.path,
              layout: layoutName,
              allowed,
            },
          });
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
