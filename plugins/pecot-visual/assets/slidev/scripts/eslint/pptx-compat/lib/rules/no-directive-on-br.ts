/**
 * ESLintカスタムルール: no-directive-on-br
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   1.x 当時は、<br> のディレクティブがリテラルテキストとして出力される前提だった。
 *   しかしディレクティブは Vue のコンパイルで DOM から消える。
 *   2.1.1 の dom-to-pptx.cjs にも、ディレクティブ文字列を出力へ載せる処理は無い。
 *   #1178 の計測では、<br v-if>（true / false）と <br :class> は、素の <br> または br 無しと同じ PPTX になった。
 *
 * 残る点:
 *   v-show="false" の要素は、display:none として DOM に残る。
 *   2.1.1 cjs `isTextContainer` は、次の子を safe inline とみなさない。
 *   対象は、inline タグ一覧に無く、inline 表示でもない子。
 *   inline タグ一覧は span / b / strong / em / i / a / small / mark で、`isSafeInline` L2751 にある。
 *   みなさない判定は `isSafeInline` L2754 にある。
 *   <br> と、通常は safe inline になる code / sup / sub / u / s は、inline 表示の要素に当たる。
 *   これらは v-show で display:none になると、この判定から外れる。
 *   すると親がテキストコンテナにならない。
 *   その結果、`prepareRenderItem` L5309 の処理で、段落がテキストノードごとの別々のテキストボックスに分割される。
 *   各テキストボックスの幅は、ブラウザの文字幅ちょうどになる。
 *   #1178 の計測では、br・code・sup・sub・u・s のいずれも 1 sp から 2 sp になった。
 *   v-show 無しの code / sup / sub / u / s は 1 sp だった。
 *
 * 検出条件: <br> と inline 表示の要素（code / sup / sub / u / s）に v-show が付いている。
 *
 * 修正方法: v-show ではなく v-if で条件分岐するか、要素自体を分割して条件分岐する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';
import { isVShowDirective } from '../utils/vue-attr-helpers.ts';

/** v-show で非表示にすると `isSafeInline` から外れ、段落を分割する inline 表示の要素（#1178 計測） */
const INLINE_BREAKER_ELEMENTS = new Set(['code', 'sup', 'sub', 'u', 's']);


const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow v-show on <br> and inline elements (code / sup / sub / u / s) for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noVShowOnBr:
        '<br>にv-showを使用しています。' +
        'v-showで非表示にしたbrはDOMに残り、PPTX変換で段落がテキストノードごとの別々のテキストボックスに分割されます。' +
        'v-ifで条件分岐するか、要素を分割して条件分岐してください。',
      noVShowOnInlineBreaker:
        '<{{tag}}>にv-showを使用しています。' +
        'v-showで非表示にした<{{tag}}>はDOMに残り、PPTX変換で段落がテキストノードごとの別々のテキストボックスに分割されます。' +
        'v-ifで条件分岐するか、要素を分割して条件分岐してください。',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VElement) {
        const isBr = node.name === 'br';
        if (!isBr && !INLINE_BREAKER_ELEMENTS.has(node.name)) {
          return;
        }

        if (!node.startTag.attributes.some(isVShowDirective)) {
          return;
        }

        if (isBr) {
          context.report({
            node: vNodeAsRuleNode(node),
            messageId: 'noVShowOnBr',
          });
          return;
        }
        context.report({
          node: vNodeAsRuleNode(node),
          messageId: 'noVShowOnInlineBreaker',
          data: { tag: node.name },
        });
      },
    });
  },
};

export default rule;
