/**
 * ESLintカスタムルール: no-shrinkwrap-absolute（#686 で narrow 緩和）。
 * position:absolute/fixed で、水平方向が shrink-wrap される要素を検出する。
 *
 * 2.1.1 で解消した点。1.1.7 当時の懸念に対する現状で、根拠位置は #1062 で更新した。
 *   1.1.7 当時は、left/top のみ指定だと幅・高さが 0 に潰れる前提だった。
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L5412-5413 は、getBoundingClientRect の実寸を優先する。
 *   サブピクセルの実寸を、offsetWidth/offsetHeight より優先して使う。
 *   そのため cx/cy が実寸から確定し、0 に潰れない。
 *   （verdict 観察: violation cx=2326779(244px) が出力された）。
 *   特に垂直方向（top のみ・bottom/height なし）は、rect 実寸 cy + autoFit で吸収される。
 *   折り返しの概念も無いため、残存リスクが無い。
 *   よって垂直検出は廃止した。
 *
 * 残る点:
 *   水平方向の shrink-wrap（left のみ・right/width なし）は、cx が実寸で確定しても問題が残る。
 *   text item が wrap:true の場合に当たる。
 *   根拠は 2.1.1 cjs `prepareRenderItem` L6038 / L6134 の `wrap: !(whiteSpace==='nowrap'||'pre')`。
 *   PowerPoint のフォントメトリクス差でテキスト幅が変動し、再折り返しするリスクが残る。
 *   （verdict: shrink-wrap 幅は明示 width と等価でない）。
 *
 * narrow 後の検出条件:
 *   水平 shrink-wrap（left あり・right/width なし）で、white-space が nowrap/pre 以外のものだけを検出する。
 *   つまり wrap:true のパターンに限る。
 *   垂直 shrink-wrap は検出しない。
 *
 * 修正方法: right:0 / width を追加して、水平方向を明示的にサイズ指定する。
 *   または white-space:nowrap で折り返しを禁止する。
 */

import type { Rule } from 'eslint';
import type * as ESTree from 'estree';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
} from '../utils/css-style-parser.ts';
import { collectPptxImageClasses } from '../utils/pptx-image-guard.ts';
import { getTemplateBody } from '../utils/template-body.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


/**
 * CSSセレクタからクラス名を抽出
 */
function extractClassNamesFromSelector(selector: string): string[] {
  const matches = selector.match(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

/**
 * セレクタのクラス名のいずれかがpptxImageClassesに含まれるか判定
 */
function selectorMatchesPptxImage(
  selector: string,
  pptxImageClasses: Set<string>,
): boolean {
  if (pptxImageClasses.size === 0) return false;
  const classNames = extractClassNamesFromSelector(selector);
  return classNames.some((cn) => pptxImageClasses.has(cn));
}

/**
 * CSS解析ロジック本体（非Vue / ハイブリッドの両方から呼ばれる）
 */
function checkStyleBlocks(
  context: Rule.RuleContext,
  node: Rule.Node,
  text: string,
  pptxImageClasses: Set<string>,
): void {
  const styleBlocks = extractStyleBlocks(text);

  for (const block of styleBlocks) {
    if (!block.css.includes('position')) continue;
    const ruleBlocks = extractRuleBlocks(block.css);

    for (const ruleBlock of ruleBlocks) {
      // data-pptx-image要素のクラスを含むセレクタをスキップ
      if (selectorMatchesPptxImage(ruleBlock.selector, pptxImageClasses)) {
        continue;
      }

      const position = getPropertyValue(ruleBlock.body, 'position');
      if (!position || !/^(absolute|fixed)$/.test(position.trim())) {
        continue;
      }

      const positionValue = position.trim();
      const inset = getPropertyValue(ruleBlock.body, 'inset');

      // inset が指定されていれば全方向が制約される
      if (inset !== null) {
        continue;
      }

      const hasLeft = getPropertyValue(ruleBlock.body, 'left') !== null;
      const hasRight = getPropertyValue(ruleBlock.body, 'right') !== null;
      const hasWidth = getPropertyValue(ruleBlock.body, 'width') !== null;

      // narrow（#686）: 水平軸のみ検出する。垂直軸（top のみ）は 2.1.1 の rect 実寸計測 +
      // autoFit で潰れず折り返し概念も無いため検出しない。
      // 水平軸: left あり & right なし & width なし
      if (hasLeft && !hasRight && !hasWidth) {
        // white-space: nowrap / pre の場合は wrap:false（cjs L2766）で折り返しが発生しないためスキップ
        const whiteSpace = getPropertyValue(ruleBlock.body, 'white-space');
        const ws = whiteSpace ? whiteSpace.trim() : null;
        if (ws === 'nowrap' || ws === 'pre') {
          // wrap:false なので shrink-wrap でも折り返しリスクなし
        } else {
          context.report({
            node,
            messageId: 'shrinkwrapHorizontal',
            data: {
              position: positionValue,
              selector: ruleBlock.selector,
            },
          });
        }
      }
    }
  }
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow shrink-wrapped absolute/fixed positioning for PPTX text box compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      shrinkwrapHorizontal:
        'position:{{position}} is shrink-wrapped horizontally (selector: {{selector}}); ' +
        'in PPTX conversion the text box width becomes the measured text width, so font differences cause line wraps ' +
        '(fix: add right:0 or a width, or prevent wrapping with white-space:nowrap)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);

    // 非Vueファイル: CSS-onlyロジック
    if (!parserServices.defineTemplateBodyVisitor) {
      return {
        Program(node) {
          const text = context.sourceCode.getText();
          checkStyleBlocks(
            context,
            vNodeAsRuleNode(node),
            text,
            new Set<string>(),
          );
        },
      };
    }

    // Vueファイル: ハイブリッド（テンプレート AST の直接走査と CSS 解析）
    // 注意: defineTemplateBodyVisitor の実行順序は次のとおり。
    // 1. scriptVisitor(Program:exit)が先に実行される。
    // 2. templateVisitor(VElement等)が後に実行される。
    // そのため pptxImageClasses の収集は、Program:exit 内でテンプレート AST を直接走査する。
    return parserServices.defineTemplateBodyVisitor(
      {},
      {
        'Program:exit'(node: ESTree.Program) {
          // テンプレートASTからdata-pptx-image要素のクラスを収集
          const templateBody = getTemplateBody(context);
          const pptxImageClasses = templateBody
            ? collectPptxImageClasses(templateBody)
            : new Set<string>();

          const text = context.sourceCode.getText();
          checkStyleBlocks(
            context,
            vNodeAsRuleNode(node),
            text,
            pptxImageClasses,
          );
        },
      },
    );
  },
};

export default rule;
