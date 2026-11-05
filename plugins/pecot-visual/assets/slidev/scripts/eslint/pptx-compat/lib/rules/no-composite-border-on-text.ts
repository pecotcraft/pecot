/**
 * ESLintカスタムルール: no-composite-border-on-text
 * テキスト要素（p, h1-h6）に非均一border（border-leftのみ等）を検出
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   1.x 当時は CSS padding が text inset に反映されず、全て lIns=0 になる前提だった。
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L5941 は、padding を次の順で margin に渡す。
 *   順は [left, right, bottom, top] で、pptxgenjs の読み順と一致する。
 *   そのため padding は辺ごとに inset へ反映される。
 *   #1178 の計測では、padding-left 12px で lIns=12px、padding-top 4px で tIns=4px だった。
 *
 * 残る点:
 *   inset に border 幅が足されない。
 *   テキストの図形は border-box の寸法で置かれる（2.1.1 cjs の `prepareRenderItem` L5412）。
 *   composite border は同じ矩形の SVG 画像として、テキストの背面に描かれる。
 *   根拠は 2.1.1 cjs の `prepareRenderItem` L6157 と、判定の `getBorderInfo` L2316 にある。
 *   そのため CSS のテキスト開始位置（border 幅 + padding）に対し、PPTX は border 側へ寄る。
 *   寄る量は border 幅と同じ。
 *   padding が border 幅未満の辺では、文字が border に重なる。
 *   #1178 の計測では、border-left 8px + padding-left 0 で lIns=0 となり、先頭文字が border に重なった。
 *   border-right と border-top も同様に 6〜8px 寄る。上寄せの border-bottom は見た目の差なし。
 *
 * 検出条件: p / h1-h6 のインライン style・:style・クラスに個別辺の border 指定がある。
 *
 * 修正方法: border を独立した着色 div に分離し、テキストは margin-left で配置する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import { extractStyleBlocks } from '../utils/css-style-parser.ts';
import type { StyleBlock } from '../utils/css-style-parser.ts';
import {
  isPlainAttribute,
  isVBindDirective,
  getStaticClassNames,
} from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


const TEXT_ELEMENTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// border-left, border-right, border-top, border-bottom（個別辺指定）
const SIDE_BORDER_PROPS = [
  'border-left',
  'border-right',
  'border-top',
  'border-bottom',
  'border-left-width',
  'border-right-width',
  'border-top-width',
  'border-bottom-width',
];

/**
 * インラインstyleにcomposite borderがあるか
 */
function hasInlineCompositeBorder(node: AST.VElement): boolean {
  if (!node.startTag || !node.startTag.attributes) {
    return false;
  }

  for (const attr of node.startTag.attributes) {
    if (
      isPlainAttribute(attr) &&
      attr.key.name === 'style' &&
      attr.value &&
      attr.value.value
    ) {
      const styleText = attr.value.value;
      for (const prop of SIDE_BORDER_PROPS) {
        const regex = new RegExp(`(?:^|;)\\s*${prop}\\s*:`, 'i');
        if (regex.test(styleText)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * v-bind style（:style）にcomposite border関連のプロパティがあるか
 */
function hasVBindCompositeBorder(node: AST.VElement): boolean {
  if (!node.startTag || !node.startTag.attributes) {
    return false;
  }

  for (const attr of node.startTag.attributes) {
    if (isVBindDirective(attr, 'style')) {
      // :style="{ borderLeftColor: ... }" のようなケースを検出
      if (attr.value && attr.value.expression) {
        const expr = attr.value.expression;
        if (expr.type === 'ObjectExpression') {
          for (const prop of expr.properties) {
            if (prop.type !== 'Property') continue;
            let name: string | null = null;
            if (prop.key.type === 'Identifier') {
              name = prop.key.name;
            } else if (
              prop.key.type === 'Literal' &&
              typeof prop.key.value === 'string'
            ) {
              name = prop.key.value;
            }
            if (name && /^border(Left|Right|Top|Bottom)/.test(name)) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

/**
 * CSSブロック内のクラスルールにcomposite borderがあるか
 */
function classHasCompositeBorder(cssText: string, className: string): boolean {
  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classRegex = new RegExp(
    `\\.${escapedClassName}(?=[\\s{,.:#[>+~])(?:[^{]*?)\\{([^}]+)\\}`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(cleanCss)) !== null) {
    const rulesText = match[1];
    for (const prop of SIDE_BORDER_PROPS) {
      const propRegex = new RegExp(
        `(?:^|;|\\s)${prop}\\s*:`,
        'i',
      );
      if (propRegex.test(rulesText)) {
        return true;
      }
    }
  }

  return false;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow composite (non-uniform) borders on text elements for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      compositeBorder:
        'テキスト要素（<{{tag}}>）にcomposite border（border-left等の個別辺指定）が検出されました。' +
        'PPTXではborder幅がtext insetに加算されず、テキストがborder幅ぶんborder側へ寄ります（paddingがborder幅未満の辺では文字がborderに重なります）。' +
        'borderを独立した着色divに分離し、テキストはmargin-leftで配置してください。',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    let styleBlocks: StyleBlock[] | null = null;

    function getStyleBlocks(): StyleBlock[] {
      if (styleBlocks === null) {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();
        styleBlocks = extractStyleBlocks(text);
      }
      return styleBlocks;
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VNode) {
        if (node.type !== 'VElement') return;
        if (!TEXT_ELEMENTS.has(node.name)) {
          return;
        }

        // 1. インラインstyleでcomposite border
        if (hasInlineCompositeBorder(node)) {
          context.report({
            node: vNodeAsRuleNode(node),
            messageId: 'compositeBorder',
            data: { tag: node.name },
          });
          return;
        }

        // 2. v-bind styleでcomposite border
        if (hasVBindCompositeBorder(node)) {
          context.report({
            node: vNodeAsRuleNode(node),
            messageId: 'compositeBorder',
            data: { tag: node.name },
          });
          return;
        }

        // 3. CSSクラスでcomposite border
        const classNames = getStaticClassNames(node);
        if (classNames.length > 0) {
          const blocks = getStyleBlocks();
          for (const className of classNames) {
            for (const block of blocks) {
              if (classHasCompositeBorder(block.css, className)) {
                context.report({
                  node: vNodeAsRuleNode(node),
                  messageId: 'compositeBorder',
                  data: { tag: node.name },
                });
                return;
              }
            }
          }
        }
      },
    });
  },
};

export default rule;
