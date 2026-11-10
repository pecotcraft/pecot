/**
 * ESLintカスタムルール: no-css-filter
 * <style>内のfilterプロパティを検出（filter: none, blur()のみを除く）
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *   blur() は 1.x 当時から、背景色付きブロック要素の SVG 化で対応している。
 *   2.1.1 でも同じで、本規則は blur() のみの filter を対象外にしている。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs で style.filter を読むのは `prepareRenderItem` L5891 だけ。
 *   `getSoftEdges` L2617 が blur(Npx) を抽出するのみ。
 *   brightness / saturate / invert / sepia / hue-rotate 等の色操作 filter は無視される。
 *   出力される色は filter 適用前のままになる。
 *   #1178 の計測では、有色の background + filter: brightness(0) の要素が、filter を当てる前の background の色で出力された。
 *
 * 検出条件: <style> のルールに none / blur() のみ以外の filter がある。
 *   data-pptx-image 配下を対象とするセレクタは除く。
 *
 * 修正方法: SVG アイコンの色変更はインライン SVG + fill="currentColor" + CSS color で代替する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
  stripKeyframesBlocks,
} from '../utils/css-style-parser.ts';
import {
  hasPptxImageAncestor,
  collectPptxImageClasses,
} from '../utils/pptx-image-guard.ts';
import { getTemplateBody } from '../utils/template-body.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow CSS filter property for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noCssFilter:
        'CSS filter is ignored in PPTX conversion (fix: to recolor an SVG icon, use inline SVG with fill="currentColor" and CSS color)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    let checked = false;

    /**
     * セレクタが data-pptx-image 配下のコンテンツを対象としているか判定する。
     * セレクタ内のいずれかのクラスが pptxImageClasses に含まれていれば、
     * そのセレクタは data-pptx-image サブツリー内の要素をスコープとしている。
     */
    function selectorTargetsPptxImageClasses(
      selector: string,
      pptxImageClasses: Set<string>,
    ): boolean {
      if (pptxImageClasses.size === 0) return false;
      const selectorClasses = selector.match(/\.([a-zA-Z0-9_-]+)/g);
      if (!selectorClasses || selectorClasses.length === 0) return false;
      return selectorClasses.some((sc) => pptxImageClasses.has(sc.slice(1)));
    }

    return parserServices.defineTemplateBodyVisitor({
      // テンプレートボディのルート要素でCSS を解析する。1回だけ実行する。
      'VElement:exit'(node: AST.VElement) {
        if (hasPptxImageAncestor(node)) {
          return;
        }

        // templateタグ直下のVElement（ルートコンポーネント要素）のみ処理
        if (
          checked ||
          !node.parent ||
          node.parent.type !== 'VElement' ||
          node.parent.parent?.type !== 'VDocumentFragment'
        ) {
          return;
        }
        checked = true;

        const templateBody = getTemplateBody(context);
        const pptxImageClasses = templateBody
          ? collectPptxImageClasses(templateBody)
          : new Set<string>();

        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();

        const styleBlocks = extractStyleBlocks(text);

        for (const block of styleBlocks) {
          // @keyframesブロックを除去してからfilterを検索
          const cssWithoutKeyframes = stripKeyframesBlocks(block.css);
          const ruleBlocks = extractRuleBlocks(cssWithoutKeyframes);

          for (const rule of ruleBlocks) {
            const filterValue = getPropertyValue(rule.body, 'filter');
            if (filterValue === null) continue;

            // filter: none は無害なので除外
            if (filterValue.trim() === 'none') continue;

            // blur()のみのfilterはdom-to-pptxで対応済みなので除外
            // blur()以外の関数が含まれていなければスキップ
            if (/^blur\(/.test(filterValue.trim()) && !/(?:brightness|saturate|invert|sepia|hue-rotate|contrast|grayscale|drop-shadow|opacity)\s*\(/.test(filterValue)) continue;

            // セレクタがdata-pptx-image配下のクラスのみを対象とする場合はスキップ
            if (
              selectorTargetsPptxImageClasses(rule.selector, pptxImageClasses)
            ) {
              continue;
            }

            context.report({
              node: vNodeAsRuleNode(node),
              messageId: 'noCssFilter',
            });
          }
        }
      },
    });
  },
};

export default rule;
