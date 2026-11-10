/**
 * ESLintカスタムルール: no-span-text-wrapper
 * <span>がブロック要素の直接の子でテキストラッパーとして使われている場合を検出
 *
 * 2.1.1 で何が解消したか（1.x 当時の懸念に対する現状。根拠位置は #1178 で更新）。
 *   解消したものは無い。
 *
 * 何が残るか（親が flex / grid でなく、span 自身が block / flex / grid 表示でない場合）。
 *   2.1.1 の dom-to-pptx.cjs `isTextContainer` L2703 は、子が全て safe inline なら親をテキストコンテナにする。
 *   safe inline は span 等の inline タグと inline / inline-block 表示を指す。
 *   テキストを持てば背景があっても safe になる。
 *   その子孫は `prepareRenderItem` L5372 で独立図形にならず、L6208 で再帰も止まる。
 *   span は親のテキストボックスの run に吸収され、span の幅・padding・背景の矩形は失われる。
 *   背景色は文字の蛍光ペン（a:highlight、`getTextStyle` L2690）になる。
 *   #1178 の計測では、幅 320px の inline-block span 2 つが w=640 の 1 sp・2 run に吸収された。
 *   親が flex / grid のとき、または span 自身が block / flex / grid 表示のときは safe inline にならない。
 *   この場合 span は独立図形になり、幅・padding・背景が保持される。
 *   根拠は `isSafeInline` L2743 と L2747 にある。
 *
 * 検出条件: div 等のブロック要素の直接の子で、class を持ち、テキストか {{ }} だけを含む span。
 *   親と span の display は CSS・class の組み合わせで決まり静的に判定しきれないため、
 *   display による除外はしない。
 *
 * 修正方法: <div> または <p> を使用する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import { isPlainAttribute, isVBindDirective } from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


const BLOCK_ELEMENTS = new Set([
  'div',
  'section',
  'template',
  'article',
  'main',
  'aside',
  'header',
  'footer',
  'nav',
]);

const INLINE_PARENT_ELEMENTS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'a',
  'td',
  'th',
]);

/**
 * ノードがテキストまたは式（{{ }}）のみを含むか判定
 */
function containsOnlyTextOrExpression(node: AST.VElement): boolean {
  if (!node.children || node.children.length === 0) {
    return true;
  }

  return node.children.every(
    (child) =>
      child.type === 'VText' || child.type === 'VExpressionContainer',
  );
}

/**
 * ノードにclass属性があるか判定
 */
function hasClassAttribute(node: AST.VElement): boolean {
  if (!node.startTag || !node.startTag.attributes) {
    return false;
  }

  return node.startTag.attributes.some((attr) => {
    if (isPlainAttribute(attr) && attr.key.name === 'class') {
      return true;
    }
    if (isVBindDirective(attr, 'class')) {
      return true;
    }
    return false;
  });
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow <span> as text wrapper in block elements for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noSpanTextWrapper:
        '<span> is used as a text wrapper; ' +
        'in PPTX conversion, when the parent is not flex / grid and the span is not displayed as block / flex / grid, ' +
        'the <span> is absorbed into the parent text box and its width, padding, and background rectangle are lost ' +
        '(fix: use <div> or <p>)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VElement) {
        if (node.name !== 'span') {
          return;
        }

        // 親要素の確認
        const parent = node.parent;
        if (!parent || parent.type !== 'VElement') {
          return;
        }

        // 親がインライン要素の場合はスキップ（正当なインライン装飾）
        if (INLINE_PARENT_ELEMENTS.has(parent.name)) {
          return;
        }

        // 親がブロック要素でない場合はスキップ
        if (!BLOCK_ELEMENTS.has(parent.name)) {
          return;
        }

        // class属性があるか（スタイル付きの独立テキスト要素）
        if (!hasClassAttribute(node)) {
          return;
        }

        // テキストや {{ }} のみを含むか
        if (!containsOnlyTextOrExpression(node)) {
          return;
        }

        context.report({
          node: vNodeAsRuleNode(node),
          messageId: 'noSpanTextWrapper',
        });
      },
    });
  },
};

export default rule;
