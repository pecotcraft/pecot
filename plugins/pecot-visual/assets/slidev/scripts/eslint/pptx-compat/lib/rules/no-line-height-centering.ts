/**
 * ESLintカスタムルール: no-line-height-centering（#686 で narrow 緩和）
 *
 * 2.1.1 で何が解消したか（根拠位置は #1062 で更新）。
 *   1.1.7 当時の懸念は、line-height が「巨大 lineSpacing」に化けてテキストが下方へずれることだった。
 *   2.1.1 の dom-to-pptx.cjs `getTextStyle` L2624-2657 は lineSpacing = lhPx * 0.75 * scale で算出する。
 *   そのため line-height:32px は 24pt（箱高 32px 相当）にとどまり、暴走しない。
 *   verdict 観察: LH_CENTER lnSpc=24pt。
 *
 * 何が残るか。
 *   line-height 単体では縦中央寄せにならず、anchor="t" のままになる。
 *   verdict 観察: LH_CENTER anchor=t。
 *   縦中央寄せには verticalAlign:middle の併用が必須になる。
 *   2.1.1 cjs `prepareRenderItem` L5912 の次の処理で anchor="ctr" になる。
 *   `if (style.verticalAlign === "middle") valign = "middle"`。
 *   verdict 観察: LH_VALIGN は line-height:32px を維持したまま anchor=ctr を得た。
 *
 * narrow 後の検出条件。
 *   次のパターンだけを検出する。height==line-height、または親 height / 親依存サイズ + 絶対 line-height。
 *   ただし **vertical-align:middle を併用しない**ものに限る。併用すれば縦中央寄せ依存が成立するため。
 *   line-height を持つ要素が vertical-align:middle を併用していれば valid。
 *
 * 修正方法: vertical-align:middle を併用して縦中央寄せを成立させるか、
 *   line-heightを相対値（1.15等）にするか、padding-topで物理配置する。
 */

import type { Rule } from 'eslint';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
  parseAbsoluteLength,
} from '../utils/css-style-parser.ts';

/**
 * セレクタから親セレクタ候補を抽出
 * 例: ".icon p" → [".icon"], ".card .icon span" → [".card .icon", ".card"]
 */
function getParentSelectors(selector: string): string[] {
  const parts = selector.split(/\s+/);
  if (parts.length <= 1) return [];

  const parents: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    parents.push(parts.slice(0, i).join(' '));
  }
  return parents;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow line-height equal to height for PPTX vertical centering compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      lineHeightCentering:
        'line-height equal to height ({{value}}) is used for vertical centering; ' +
        'without vertical-align:middle the PPTX anchor stays top, so the text is not vertically centered ' +
        '(fix: add vertical-align:middle, or use a relative line-height such as 1.15)',
      parentDependentLineHeight:
        'absolute line-height ({{value}}) on an element sized by its parent (width:100%; height:100%); ' +
        'without vertical-align:middle the PPTX anchor stays top, so the text is not vertically centered ' +
        '(fix: add vertical-align:middle, or use a relative line-height such as 1.5)',
    },
  },

  create(context) {
    return {
      Program(node) {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();

        const styleBlocks = extractStyleBlocks(text);

        for (const block of styleBlocks) {
          const ruleBlocks = extractRuleBlocks(block.css);

          // セレクタ → height(px) のマップを構築
          const heightMap = new Map<string, number>();
          for (const rule of ruleBlocks) {
            const heightVal = getPropertyValue(rule.body, 'height');
            const heightPx = parseAbsoluteLength(heightVal);
            if (heightPx !== null) {
              heightMap.set(rule.selector, heightPx);
            }
          }

          // 親依存サイズ（width:100%; height:100%）のセレクタを収集
          const parentDependentSet = new Set<string>();
          for (const rule of ruleBlocks) {
            const widthVal = getPropertyValue(rule.body, 'width');
            const heightVal = getPropertyValue(rule.body, 'height');
            if (widthVal && widthVal.trim() === '100%' &&
                heightVal && heightVal.trim() === '100%') {
              parentDependentSet.add(rule.selector);
            }
          }

          // 各ブロックで line-height をチェック
          for (const rule of ruleBlocks) {
            const lineHeightVal = getPropertyValue(rule.body, 'line-height');
            const lineHeightPx = parseAbsoluteLength(lineHeightVal);
            if (lineHeightPx === null) continue;

            // narrow（#686）: line-height を持つ要素が vertical-align:middle を併用していれば、
            // PPTX 変換で anchor="ctr" となり縦中央寄せが成立する。そのため検出対象外にする。
            const valign = getPropertyValue(rule.body, 'vertical-align');
            if (valign !== null && valign.trim() === 'middle') {
              continue;
            }

            // パターン1: 同セレクタ内に height があり同値
            const sameHeight = heightMap.get(rule.selector);
            if (sameHeight !== undefined && sameHeight === lineHeightPx) {
              context.report({
                node,
                messageId: 'lineHeightCentering',
                data: { value: lineHeightVal },
              });
              continue;
            }

            // パターン2: 親セレクタの height と同値
            const parentSelectors = getParentSelectors(rule.selector);
            let matched = false;
            for (const parent of parentSelectors) {
              const parentHeight = heightMap.get(parent);
              if (parentHeight !== undefined && parentHeight === lineHeightPx) {
                context.report({
                  node,
                  messageId: 'lineHeightCentering',
                  data: { value: lineHeightVal },
                });
                matched = true;
                break;
              }
            }
            if (matched) continue;

            // パターン3: 親依存サイズの要素で絶対line-height
            // 3a: 同セレクタが親依存
            if (parentDependentSet.has(rule.selector)) {
              context.report({
                node,
                messageId: 'parentDependentLineHeight',
                data: { value: lineHeightVal },
              });
              continue;
            }

            // 3b: 親セレクタが親依存
            let parentDepMatched = false;
            for (const parent of parentSelectors) {
              if (parentDependentSet.has(parent)) {
                context.report({
                  node,
                  messageId: 'parentDependentLineHeight',
                  data: { value: lineHeightVal },
                });
                parentDepMatched = true;
                break;
              }
            }
            if (parentDepMatched) continue;
          }
        }
      },
    };
  },
};

export default rule;
