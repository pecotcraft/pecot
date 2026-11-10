/**
 * ESLintカスタムルール: require-absolute-last
 * position:absoluteな子要素が、同じ親内で非absolute兄弟より前にある場合を検出
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `processSlide` L4615 は、並び順のキーを [z-index, DOM 順] で作る。
 *   z-index:auto は 0 として扱い、position を見ない。
 *   `processSlide` L4666 は、このキーで並べ替えて追加する。
 *   そのため DOM 順がそのまま重なり順になる。
 *   ブラウザでは前面に描かれる absolute 要素も、後ろの兄弟の背面に回る。
 *   #1178 の計測では、先に置いた absolute のバッジが、カード全面を覆う本文の背面に出力された。
 *
 * 判定:
 * - CSS で position:absolute を持つクラスを特定する。
 * - テンプレート AST 上で、absolute 要素の後に非 absolute 兄弟がいる場合に報告する。
 *
 * 修正方法: absolute 要素を兄弟の末尾に移動する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
  type StyleBlock,
  type RuleBlock,
} from '../utils/css-style-parser.ts';
import { getStaticClassNames } from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';

// ヘルパー: セレクタ内のクラス名を抽出

function extractClassNamesFromSelector(selector: string): string[] {
  const matches = selector.match(/\.([a-zA-Z0-9_-]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

// ヘルパー: ノードがposition:absoluteクラスを持つか

function isAbsoluteElement(
  node: AST.VElement,
  absoluteClassNames: Set<string>,
): boolean {
  const classNames = getStaticClassNames(node);
  return classNames.some((cn) => absoluteClassNames.has(cn));
}

// Vueコンポーネント（PascalCase）と <slot> は、positioning が外部に隠蔽されている。
// L3 Component が内部で position:absolute を持つ場合があるため、兄弟シーケンスから除外する。
function isOpaqueElement(node: AST.VElement): boolean {
  const name = node.rawName || '';
  if (name === 'slot') return true;
  // PascalCase 判定: 先頭大文字 ASCII（kebab-case や HTML 標準タグは除外）
  return /^[A-Z]/.test(name);
}

// ルール本体

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require position:absolute elements to come after non-absolute siblings for PPTX z-order compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      absoluteBeforeSibling:
        'position:absolute element (.{{className}}) is placed before non-absolute siblings; ' +
        'in PPTX the DOM order is the z-order (fix: move the absolute element to the end of its siblings)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);

    if (!parserServices.defineTemplateBodyVisitor) {
      // 非Vueファイルはスキップ（テンプレートAST走査が必要）
      return {};
    }

    let styleBlocks: StyleBlock[] | null = null;
    let ruleBlocksCache: RuleBlock[] | null = null;

    function getRuleBlocks(): RuleBlock[] {
      if (ruleBlocksCache === null) {
        if (styleBlocks === null) {
          const text = context.sourceCode.getText();
          styleBlocks = extractStyleBlocks(text);
        }
        ruleBlocksCache = [];
        for (const block of styleBlocks) {
          ruleBlocksCache.push(...extractRuleBlocks(block.css));
        }
      }
      return ruleBlocksCache;
    }

    /**
     * CSSからposition:absoluteを持つクラス名一覧を取得
     */
    function findAbsoluteClassNames(): Set<string> {
      const ruleBlocks = getRuleBlocks();
      const classNames = new Set<string>();

      for (const ruleBlock of ruleBlocks) {
        const position = getPropertyValue(ruleBlock.body, 'position');
        if (position && position.trim() === 'absolute') {
          for (const cn of extractClassNamesFromSelector(ruleBlock.selector)) {
            classNames.add(cn);
          }
        }
      }

      return classNames;
    }

    let checked = false;

    return parserServices.defineTemplateBodyVisitor({
      'VElement:exit'(node: AST.VElement) {
        if (
          checked ||
          !node.parent ||
          node.parent.type !== 'VElement' ||
          node.parent.parent?.type !== 'VDocumentFragment'
        ) {
          return;
        }
        checked = true;

        const absoluteClassNames = findAbsoluteClassNames();
        if (absoluteClassNames.size === 0) return;

        // テンプレートAST全体を走査
        function checkChildren(vNode: AST.VElement): void {
          // この要素の直接の子VElement群を取得
          const childElements = vNode.children.filter(
            (c): c is AST.VElement => c.type === 'VElement',
          );

          // absolute 子要素の後に非 absolute 子要素があるか確認する
          let lastAbsoluteNode: AST.VElement | null = null;
          let lastAbsoluteClassName: string | null = null;
          for (const child of childElements) {
            // Vueコンポーネント（PascalCase）/ <slot> は positioning が判定不能のため透過
            if (isOpaqueElement(child)) {
              continue;
            }
            if (isAbsoluteElement(child, absoluteClassNames)) {
              lastAbsoluteNode = child;
              const classNames = getStaticClassNames(child);
              lastAbsoluteClassName =
                classNames.find((cn) => absoluteClassNames.has(cn)) ||
                classNames[0] ||
                null;
            } else if (lastAbsoluteNode) {
              // absolute要素の後に非absolute要素がある → 報告
              context.report({
                node: vNodeAsRuleNode(lastAbsoluteNode),
                messageId: 'absoluteBeforeSibling',
                data: {
                  className: lastAbsoluteClassName ?? '',
                },
              });
              lastAbsoluteNode = null;
            }
          }

          // 子の子も再帰走査
          for (const child of childElements) {
            checkChildren(child);
          }
        }

        checkChildren(node);
      },
    });
  },
};

export default rule;
