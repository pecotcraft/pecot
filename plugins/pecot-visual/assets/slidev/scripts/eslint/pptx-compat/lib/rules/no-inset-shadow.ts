/**
 * ESLintカスタムルール: no-inset-shadow
 * <style>内のbox-shadowプロパティ値にinsetを含む場合を検出
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   1.x 当時は、inset シャドウが消える前提だった。
 *   2.1.1 では消えずに出力されるが、内側の影にはならない。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `getVisibleShadow` L2910 は inset を判定しない。
 *   影は type:'outer' で返る。
 *   影は `prepareRenderItem` L6097 で図形に付く。
 *   テキストを持つ要素も、L6127 で同じ影を受け継ぐ。
 *   そのため inset シャドウは外側の影（a:outerShdw）として出力される。
 *   テキストのみの要素では、文字の影になる。
 *   #1178 の計測では、背景あり・テキストのみの両方で a:outerShdw が出て、a:innerShdw は 0 件だった。
 *
 * 検出条件: <style> の box-shadow の値に inset を含む。
 *
 * 修正方法: 外部シャドウを使うか、画像として書き出す。
 */

import type { Rule } from 'eslint';
import {
  extractStyleBlocks,
  findCssPropertyWithValue,
} from '../utils/css-style-parser.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow box-shadow: inset for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noInsetShadow:
        'box-shadow: inset does not become an inner shadow in PPTX conversion; it is output as an outer shadow (a text-only element gets a text shadow) (fix: use an outer shadow, or export it as an image)',
    },
  },

  create(context) {
    return {
      Program(node) {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();

        const styleBlocks = extractStyleBlocks(text);

        for (const block of styleBlocks) {
          const matches = findCssPropertyWithValue(
            block.css,
            'box-shadow',
            /\binset\b/i,
          );

          for (const _match of matches) {
            context.report({
              node,
              messageId: 'noInsetShadow',
            });
          }
        }
      },
    };
  },
};

export default rule;
