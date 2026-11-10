/**
 * ESLintカスタムルール: no-decorative-bar-element（#686 で narrow 緩和）
 * position:absoluteで装飾バー要素（幅または高さ5px以下）を検出
 *
 * 2.1.1 で解消した点。1.1.7 当時の懸念に対する現状で、根拠位置は #1062 で更新した。
 *   1.1.7 当時は、小さな absolute 要素が描画から脱落する懸念があった。
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L5398-5399 には、マイクロ装飾の下限ガードがある。
 *   ガードは `if (rect.width < 0.5 || rect.height < 0.5) return null` で、0.5px 未満のみ破棄する。
 *   そのため 4px バーは閾値超で、独立図形として確実に描画される。
 *   （verdict 観察: DECO_BAR_4PX の sp が cy=38100(4px) で出力された）。
 *   バーの「描画消失」リスクは解消した。
 *
 * 残る点:
 *   バーは geom=rect の独立図形になる。cjs にクリップ波及機構が無い点は、2.1.1 でも同じ。
 *   そのため親の overflow:hidden / border-radius による角丸クリップは継承されない。
 *   （verdict 観察: 角丸カード内バー x=381000 geom=rect が、親 roundRect の角に重なった）。
 *   つまり「角丸コンテナの角を細バーが侵食する」問題のみ残存する。
 *
 * narrow 後の検出条件:
 *   細バーの祖先に border-radius（角丸）がある場合のみ報告する。
 *   角丸でない（border-radius 無し）祖先内のバーは、角侵食が起きないため valid とする。
 *   overflow:hidden の有無は判定に用いない。
 *   クリップ波及機構が無く、角丸でなければ侵食しないため。
 *
 * 非Vueファイルの場合は CSS-only で全件報告する（フォールバック）。
 *
 * 非Vue（CSS-only）フォールバックが、角丸祖先判定なしの全件報告になる理由（F-06, 意図的）:
 *   CSS-only ファイルにはテンプレート AST が無い。
 *   どの装飾バーが角丸祖先の配下に置かれるか（祖先構造）を判定できない。
 *   よって narrow（角丸祖先のみ報告）を適用できず、保守側に倒して全件報告とする。
 *   なお現行の lint config（eslint.config.js）は、pptx-compat を .vue（layoutFiles）のみ対象とする。
 *   そのため、この非Vue のパスは実質デッドパスになっている。
 *   将来 CSS 単体ファイルを対象に含めた場合でも、false negative を出さないよう意図的に保守側へ倒している。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
  parseAbsoluteLength,
} from '../utils/css-style-parser.ts';
import type { StyleBlock, RuleBlock } from '../utils/css-style-parser.ts';
import {
  isPlainAttribute,
  isVBindDirective,
  getStaticClassNames,
} from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';

// ヘルパー: セレクタ内にクラス名が完全一致で含まれるか

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function selectorContainsClass(selector: string, className: string): boolean {
  const escaped = escapeRegex(className);
  const regex = new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`);
  return regex.test(selector);
}

// ヘルパー: CSSルールブロックから指定プロパティの値を取得

function getPropertyValueFromCss(
  ruleBlocks: RuleBlock[],
  classNames: string[],
  property: string,
): string | null {
  for (const rule of ruleBlocks) {
    const matchesAnyClass = classNames.some((cn) =>
      selectorContainsClass(rule.selector, cn),
    );
    if (matchesAnyClass) {
      const value = getPropertyValue(rule.body, property);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

// ヘルパー: インラインstyle属性からプロパティ値を取得

function getInlineStyleValue(
  node: AST.VElement,
  property: string,
): string | null {
  if (!node.startTag || !node.startTag.attributes) {
    return null;
  }

  for (const attr of node.startTag.attributes) {
    if (
      isPlainAttribute(attr) &&
      attr.key.name === 'style' &&
      attr.value &&
      attr.value.value
    ) {
      const regex = new RegExp(
        `(?:^|;)\\s*${escapeRegex(property)}\\s*:\\s*([^;]+)`,
        'i',
      );
      const match = regex.exec(attr.value.value);
      return match ? match[1].trim() : null;
    }
  }

  return null;
}

// ヘルパー: border-radius 値が「角丸」か判定（数値解析ベース）
// 値を空白区切りでトークン化し、全トークンが数値ゼロなら角丸でない（false）。
// none / 空文字も角丸でない。単位（px/%/em/rem/pt/vw/...）は parseFloat で無視されるため
// 単位の収録欠落に依存しない（F-02: 0pt / 0vw 等も正しくゼロ判定する）。
// 静的解析不可（変数参照等）の null は呼び出し側で別途扱う。

function isRoundedValue(value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'none') return false;
  // "/" は border-radius の水平/垂直半径区切り。空白と同様にトークン境界として扱う
  const tokens = v.split(/[\s/]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    const num = parseFloat(token);
    // 数値として解釈できない（calc(...) や var(...) 等）→ 静的に 0 と確定できないため角丸扱い
    if (Number.isNaN(num)) return true;
    if (num !== 0) return true;
  }
  return false;
}

// ヘルパー: :style バインディングの borderRadius が角丸か判定
// borderRadius の値がゼロリテラル（0 / '0' / '0px' 等）ならスキップ（角丸でない）。
// 値が変数参照など静的解析不可の場合は保守側に倒して true（現挙動維持・F-01）。

function vBindStyleBorderRadiusIsRounded(node: AST.VElement): boolean {
  if (!node.startTag || !node.startTag.attributes) {
    return false;
  }

  for (const attr of node.startTag.attributes) {
    if (isVBindDirective(attr, 'style')) {
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
            if (name !== 'borderRadius') continue;

            // 値がリテラル（数値 or 文字列）なら静的にゼロ判定できる
            if (prop.value.type === 'Literal') {
              const lit = prop.value.value;
              if (typeof lit === 'number') {
                if (lit !== 0) return true;
                // ゼロ数値リテラル → 角丸でない（このキーはスキップ）
                continue;
              }
              if (typeof lit === 'string') {
                return isRoundedValue(lit);
              }
            }
            // 変数参照・式など静的解析不可 → 保守側に倒して角丸扱い（現挙動維持）
            return true;
          }
        }
      }
    }
  }

  return false;
}

// ヘルパー: ノードが border-radius（角丸）を持つか（3分岐の判定）。
// narrow（#686）: クリップ波及機構が無いため overflow:hidden ではなく
// 角丸（border-radius）祖先のみが角侵食リスクを持つ。

function nodeHasBorderRadius(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  // 1. インラインstyle
  const inlineValue = getInlineStyleValue(node, 'border-radius');
  if (isRoundedValue(inlineValue)) {
    return true;
  }

  // 2. :style バインディング
  if (vBindStyleBorderRadiusIsRounded(node)) {
    return true;
  }

  // 3. CSSクラス
  const classNames = getStaticClassNames(node);
  if (classNames.length > 0) {
    const cssValue = getPropertyValueFromCss(
      ruleBlocks,
      classNames,
      'border-radius',
    );
    if (isRoundedValue(cssValue)) {
      return true;
    }
  }

  return false;
}

// ヘルパー: テンプレートAST内で装飾バーセレクタにマッチするVElementを探す

/**
 * 装飾バーセレクタに含まれるクラスが、VElementのクラスに一致するか判定
 */
function elementMatchesBarSelector(
  node: AST.VElement,
  barSelector: string,
): boolean {
  const classNames = getStaticClassNames(node);
  if (classNames.length === 0) return false;

  // セレクタからクラス名を抽出
  const selectorClasses = barSelector.match(/\.([a-zA-Z0-9_-]+)/g);
  if (!selectorClasses || selectorClasses.length === 0) return false;

  // セレクタの最終クラス部分がノードのクラスに含まれるか
  for (const selectorClass of selectorClasses) {
    const className = selectorClass.slice(1); // ドットを除去
    if (classNames.includes(className)) {
      return true;
    }
  }
  return false;
}

/**
 * VElementの親をたどり、いずれかの祖先がborder-radius（角丸）を持つか判定
 * narrow（#686）: 角丸祖先内のバーのみが角侵食リスクを持つ。
 */
function hasRoundedAncestor(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  let current: AST.VElement | AST.VDocumentFragment | null = node.parent;
  while (current && current.type === 'VElement') {
    if (nodeHasBorderRadius(current, ruleBlocks)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// ルール本体

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow decorative bar elements using position:absolute for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      decorativeBarElement:
        'position:absolute decorative bar inside a border-radius ancestor (selector: {{selector}}); ' +
        'dom-to-pptx turns a small absolute element into a separate shape (geom=rect), ' +
        'which does not inherit the rounded clip of its parent and cuts into the corners ' +
        '(fix: merge it into the parent with CSS border-top/border-left/border-right)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);

    // 非Vueファイル: CSS-onlyフォールバック
    if (!parserServices.defineTemplateBodyVisitor) {
      return {
        Program(node) {
          const sourceCode = context.sourceCode;
          const text = sourceCode.getText();

          const styleBlocks = extractStyleBlocks(text);

          for (const block of styleBlocks) {
            if (!block.css.includes('position')) continue;
            const ruleBlocks = extractRuleBlocks(block.css);

            for (const rule of ruleBlocks) {
              const position = getPropertyValue(rule.body, 'position');
              if (!position || position.trim() !== 'absolute') {
                continue;
              }

              const widthValue = parseAbsoluteLength(
                getPropertyValue(rule.body, 'width'),
              );
              const heightValue = parseAbsoluteLength(
                getPropertyValue(rule.body, 'height'),
              );

              const isNarrow = widthValue !== null && widthValue <= 5;
              const isShort = heightValue !== null && heightValue <= 5;

              if (isNarrow || isShort) {
                context.report({
                  node,
                  messageId: 'decorativeBarElement',
                  data: {
                    selector: rule.selector,
                  },
                });
              }
            }
          }
        },
      };
    }

    // Vueファイル: ハイブリッド判定（テンプレートAST + CSS解析）
    let styleBlocks: StyleBlock[] | null = null;
    let ruleBlocksCache: RuleBlock[] | null = null;

    function getStyleBlocks(): StyleBlock[] {
      if (styleBlocks === null) {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();
        styleBlocks = extractStyleBlocks(text);
      }
      return styleBlocks;
    }

    function getRuleBlocks(): RuleBlock[] {
      if (ruleBlocksCache === null) {
        const blocks = getStyleBlocks();
        ruleBlocksCache = [];
        for (const block of blocks) {
          ruleBlocksCache.push(...extractRuleBlocks(block.css));
        }
      }
      return ruleBlocksCache;
    }

    /**
     * 装飾バーセレクタ一覧を検出（CSS解析）
     */
    function findBarSelectors(): string[] {
      const ruleBlocks = getRuleBlocks();
      const barSelectors: string[] = [];

      for (const rule of ruleBlocks) {
        const position = getPropertyValue(rule.body, 'position');
        if (!position || position.trim() !== 'absolute') {
          continue;
        }

        const widthValue = parseAbsoluteLength(
          getPropertyValue(rule.body, 'width'),
        );
        const heightValue = parseAbsoluteLength(
          getPropertyValue(rule.body, 'height'),
        );

        const isNarrow = widthValue !== null && widthValue <= 5;
        const isShort = heightValue !== null && heightValue <= 5;

        if (isNarrow || isShort) {
          barSelectors.push(rule.selector);
        }
      }

      return barSelectors;
    }

    let checked = false;

    return parserServices.defineTemplateBodyVisitor({
      'VElement:exit'(node: AST.VNode) {
        if (node.type !== 'VElement') return;
        // templateタグ直下のVElement（ルートコンポーネント要素）のみ処理（1回だけ）
        if (
          checked ||
          !node.parent ||
          node.parent.type !== 'VElement' ||
          node.parent.parent?.type !== 'VDocumentFragment'
        ) {
          return;
        }
        checked = true;

        const barSelectors = findBarSelectors();
        if (barSelectors.length === 0) return;

        const ruleBlocks = getRuleBlocks();

        // テンプレートAST全体を走査して装飾バー候補を探す
        function walkElements(
          vNode:
            | AST.VElement
            | AST.VText
            | AST.VExpressionContainer,
        ): void {
          if (vNode.type === 'VElement') {
            for (const selector of barSelectors) {
              if (elementMatchesBarSelector(vNode, selector)) {
                // narrow（#686）: 祖先に border-radius（角丸）がある場合のみ報告
                if (hasRoundedAncestor(vNode, ruleBlocks)) {
                  context.report({
                    node: vNodeAsRuleNode(vNode),
                    messageId: 'decorativeBarElement',
                    data: {
                      selector,
                    },
                  });
                }
              }
            }

            // 子要素を再帰走査
            if (vNode.children) {
              for (const child of vNode.children) {
                walkElements(child);
              }
            }
          }
        }

        // ルート要素から全体を走査
        walkElements(node);
      },
    });
  },
};

export default rule;
