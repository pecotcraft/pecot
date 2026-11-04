/**
 * ESLintカスタムルール: no-table-complex-content
 * <td>/<th>内の<img>, <svg>, <canvas>, ネストされた<table>を検出
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `extractTableData` L2125 は、セルを collectTextParts か innerText でテキスト化するだけ。
 *   画像・SVG を扱う処理が無い。
 *   table は `prepareRenderItem` L5482 で再帰を止める。
 *   そのため、セル内の img / svg / canvas は図形としても走査されず、出力から消える。
 *   さらに `extractTableData` L2154 の querySelectorAll('tr') が、入れ子の表の tr まで拾う。
 *   拾った tr は、外側の表の行として積まれる。
 *   #1178 の計測では、セル内の img と svg は pic 0 件で、入れ子の表は外側の表の 2 行目に平坦化された。
 *   canvas は同じ機構からの推定で、未計測。
 *
 * 検出条件: td / th の子孫に img / svg / canvas / table がある。
 *
 * 修正方法: テーブル外に div レイアウトで配置する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


const TABLE_CELL_ELEMENTS = new Set(['td', 'th']);
const FORBIDDEN_ELEMENTS = new Set(['img', 'svg', 'canvas', 'table']);

interface ForbiddenMatch {
  element: string;
  node: AST.VElement;
}

/**
 * ノードの子孫から禁止要素を再帰的に検索
 */
function findForbiddenDescendants(node: AST.VElement): ForbiddenMatch[] {
  const found: ForbiddenMatch[] = [];

  if (!node.children) {
    return found;
  }

  for (const child of node.children) {
    if (child.type === 'VElement') {
      if (FORBIDDEN_ELEMENTS.has(child.name)) {
        found.push({ element: child.name, node: child });
      }
      // 禁止要素の中はさらに探索しない（報告は1つで十分）
      if (!FORBIDDEN_ELEMENTS.has(child.name)) {
        found.push(...findForbiddenDescendants(child));
      }
    }
  }

  return found;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow complex content in table cells for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noTableComplexContent:
        'テーブルセル内に{{element}}要素があります。PPTXテーブルではセル内の画像・SVG・canvasは出力されず、入れ子のtableは行が外側の表に平坦化されます。テーブル外にdivレイアウトで配置してください。',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VNode) {
        if (node.type !== 'VElement') return;
        if (!TABLE_CELL_ELEMENTS.has(node.name)) {
          return;
        }

        const forbidden = findForbiddenDescendants(node);

        for (const { element, node: elementNode } of forbidden) {
          context.report({
            node: vNodeAsRuleNode(elementNode),
            messageId: 'noTableComplexContent',
            data: {
              element,
            },
          });
        }
      },
    });
  },
};

export default rule;
