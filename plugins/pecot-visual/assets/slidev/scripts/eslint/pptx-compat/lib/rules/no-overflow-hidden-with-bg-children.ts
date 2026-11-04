/**
 * ESLintカスタムルール: no-overflow-hidden-with-bg-children
 * overflow:hidden + border-radius を持つ親要素の子要素を検出する。
 * 対象は、非透明な background/background-color を持つが border-radius がないもの。
 *
 * require-child-border-radius-in-rounded-container との違い:
 * - テキストの有無に関わらず検出する（装飾divも対象）。
 * - 透明背景（transparent, none, rgba(...,0)）は除外する。
 * - 修正方向が異なる。子要素の背景削除か親への統合を推奨する。
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L6101 は、子の角丸を子自身の border-radius だけで決める。
 *   祖先の overflow を見る `isClippedByParent` L2244 は、限られた分岐でしか使われない。
 *   その分岐は `prepareRenderItem` L5850 の、「部分角丸 + クリップ + 内容無し」をラスタ化するもの。
 *   親のクリップを子へ波及させる機構は無い。
 *   背景付きの子は角の立った矩形で出力され、親の角丸からはみ出す。
 *   #1178 の計測では、角丸 24px の親の上端に置いた帯が geom=rect で出力された。
 *
 * 検出条件: overflow:hidden + border-radius の親の子に、border-radius の無い非透明の背景がある。
 *   img 要素は require-image-border-radius ルールでカバーするためスキップする。
 *
 * 修正方法: 子要素の背景を削除するか親に統合する。または、子要素に border-radius を設定する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  getPropertyValue,
} from '../utils/css-style-parser.ts';
import type { StyleBlock, RuleBlock } from '../utils/css-style-parser.ts';
import { hasPptxImageAncestor } from '../utils/pptx-image-guard.ts';
import {
  isPlainAttribute,
  isVBindDirective,
  getStaticClassNames,
} from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';

// 3種の検出: インライン style / :style / CSS クラス

/**
 * インラインstyle属性内に指定プロパティが含まれるか
 */
function inlineStyleHasProperty(node: AST.VElement, property: string): boolean {
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
      const regex = new RegExp(`(?:^|;)\\s*${escapeRegex(property)}\\s*:`, 'i');
      return regex.test(attr.value.value);
    }
  }

  return false;
}

/**
 * インラインstyle属性から指定プロパティの値を取得
 */
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

/**
 * :style バインディング内に指定プロパティ名(camelCase)が含まれるか
 */
function vBindStyleHasProperty(
  node: AST.VElement,
  camelProperty: string,
): boolean {
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
            if (
              prop.key.type === 'Identifier' &&
              prop.key.name === camelProperty
            ) {
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
 * セレクタ内に指定クラス名が完全一致で含まれるか判定する。
 * `.detail-header` は `.detail-header-line` にマッチしない。
 * `.caption-area` は `.caption-area.overlay-bottom` にマッチする。
 */
function selectorContainsClass(selector: string, className: string): boolean {
  const escaped = escapeRegex(className);
  const regex = new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`);
  return regex.test(selector);
}

/**
 * CSSルールブロック内で、ノードのいずれかのクラスを含むセレクタに
 * 指定プロパティが存在するか判定（複合セレクタ対応）
 */
function nodeClassesHavePropertyInCss(
  ruleBlocks: RuleBlock[],
  classNames: string[],
  property: string,
): boolean {
  for (const rule of ruleBlocks) {
    const matchesAnyClass = classNames.some((cn) =>
      selectorContainsClass(rule.selector, cn),
    );
    if (matchesAnyClass && getPropertyValue(rule.body, property) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * CSSルールブロック内で、ノードのいずれかのクラスを含むセレクタから
 * 指定プロパティの値を取得（複合セレクタ対応）
 */
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

// 統合判定: 3種のいずれかでプロパティを持つか

function nodeHasProperty(
  node: AST.VElement,
  cssProperty: string,
  camelProperty: string,
  ruleBlocks: RuleBlock[],
): boolean {
  // 1. インラインstyle
  if (inlineStyleHasProperty(node, cssProperty)) {
    return true;
  }

  // 2. :style バインディング
  if (vBindStyleHasProperty(node, camelProperty)) {
    return true;
  }

  // 3. CSSクラス
  const classNames = getStaticClassNames(node);
  if (
    classNames.length > 0 &&
    nodeClassesHavePropertyInCss(ruleBlocks, classNames, cssProperty)
  ) {
    return true;
  }

  return false;
}

/**
 * overflow の値を3種の指定から取得し、'hidden' かどうか判定する。
 */
function nodeHasOverflowHidden(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  // 1. インラインstyle
  const inlineValue = getInlineStyleValue(node, 'overflow');
  if (inlineValue && inlineValue === 'hidden') {
    return true;
  }

  // 2. :style バインディング — overflow は動的に指定されることは稀だがチェック
  if (vBindStyleHasProperty(node, 'overflow')) {
    // 値の精密判定は困難なので、存在すればtrue扱い
    return true;
  }

  // 3. CSSクラス
  const classNames = getStaticClassNames(node);
  if (classNames.length > 0) {
    const cssValue = getPropertyValueFromCss(
      ruleBlocks,
      classNames,
      'overflow',
    );
    if (cssValue && cssValue === 'hidden') {
      return true;
    }
  }

  return false;
}

/**
 * 子要素が border-radius を持つか判定
 */
function nodeHasBorderRadius(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  return nodeHasProperty(node, 'border-radius', 'borderRadius', ruleBlocks);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 透明背景判定

/**
 * 背景値が透明かどうか判定
 * transparent, none, rgba(..., 0) を透明とみなす
 */
function isTransparentBackground(value: string | null | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return (
    v === 'transparent' ||
    v === 'none' ||
    /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/.test(v)
  );
}

/**
 * ノードが非透明な背景を持つか判定（3種の指定に対応）
 * 背景プロパティが存在し、かつその値が透明でない場合にtrueを返す
 */
function nodeHasNonTransparentBackground(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  const classNames = getStaticClassNames(node);

  // background プロパティをチェック
  const props: Array<[string, string]> = [
    ['background', 'background'],
    ['background-color', 'backgroundColor'],
  ];
  for (const [cssProp, camelProp] of props) {
    // 1. インラインstyle
    const inlineValue = getInlineStyleValue(node, cssProp);
    if (inlineValue !== null) {
      if (!isTransparentBackground(inlineValue)) {
        return true;
      }
      // 透明値が明示されている場合、このプロパティは透明として確定
      continue;
    }

    // 2. :style バインディング
    if (vBindStyleHasProperty(node, camelProp)) {
      // 動的値の判定は困難なので、存在すれば非透明とみなす（保守的）
      return true;
    }

    // 3. CSSクラス
    if (classNames.length > 0) {
      const cssValue = getPropertyValueFromCss(
        ruleBlocks,
        classNames,
        cssProp,
      );
      if (cssValue !== null && !isTransparentBackground(cssValue)) {
        return true;
      }
    }
  }

  return false;
}

// ルール本体

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow background children in overflow:hidden rounded containers without border-radius for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      noOverflowHiddenWithBgChildren:
        'overflow:hidden + border-radius を持つコンテナの子要素に非透明な背景があり、border-radiusがありません。' +
        'dom-to-pptxでは親のoverflowクリッピングが失われるため、' +
        '子要素の背景を削除するか、親に統合するか、子要素にborder-radiusを設定してください。',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

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
        const collected: RuleBlock[] = [];
        for (const block of blocks) {
          collected.push(...extractRuleBlocks(block.css));
        }
        ruleBlocksCache = collected;
      }
      return ruleBlocksCache;
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VElement) {
        if (hasPptxImageAncestor(node)) {
          return;
        }

        // 親要素チェック: overflow:hidden + border-radius
        const parent = node.parent;
        if (!parent || parent.type !== 'VElement') {
          return;
        }

        const ruleBlocks = getRuleBlocks();

        const parentHasOverflow = nodeHasOverflowHidden(parent, ruleBlocks);
        const parentHasRadius = nodeHasBorderRadius(parent, ruleBlocks);

        if (!parentHasOverflow || !parentHasRadius) {
          return;
        }

        // img要素はスキップ（require-image-border-radius でカバー）
        if (node.name === 'img') {
          return;
        }

        // 子要素が非透明な背景を持つが border-radius がない場合に報告
        // テキストの有無に関わらず検出する（既存ルールとの違い）
        if (
          nodeHasNonTransparentBackground(node, ruleBlocks) &&
          !nodeHasBorderRadius(node, ruleBlocks)
        ) {
          context.report({
            node: vNodeAsRuleNode(node),
            messageId: 'noOverflowHiddenWithBgChildren',
          });
        }
      },
    });
  },
};

export default rule;
