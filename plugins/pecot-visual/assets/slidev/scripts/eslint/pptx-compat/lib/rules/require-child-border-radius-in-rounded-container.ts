/**
 * ESLintカスタムルール: require-child-border-radius-in-rounded-container
 *
 * overflow:hidden + border-radius を持つ親要素の子要素を検出する。
 * 対象は、background/background-color を持つが border-radius がないもの。
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L6101 は、子の角丸を子自身の border-radius だけで決める。
 *   親のクリップを子へ波及させる機構は無い。
 *   祖先の overflow を見る `isClippedByParent` L2244 の用途は、内容無し要素のラスタ化のみ。
 *   ラスタ化は `prepareRenderItem` L5850 にある。
 *   子の背景は角の立った矩形で出力され、親の角丸を覆い隠す。
 *   #1178 の計測では、親を全面で覆う子が roundRect ではなく geom=rect で出力された。
 *
 * 検出条件: overflow:hidden + border-radius の親の子に、border-radius の無い背景がある。
 *   img 要素は require-image-border-radius ルールでカバーするためスキップする。
 *
 * 修正方法: 子要素にも直接 border-radius を設定する。
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
 * 子要素が背景を持つか判定（background または background-color）
 */
function nodeHasBackground(
  node: AST.VElement,
  ruleBlocks: RuleBlock[],
): boolean {
  return (
    nodeHasProperty(node, 'background', 'background', ruleBlocks) ||
    nodeHasProperty(
      node,
      'background-color',
      'backgroundColor',
      ruleBlocks,
    )
  );
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

// ヘルパー: 要素がテキストを含むか判定

/**
 * テキスト系要素名のセット
 */
const TEXT_ELEMENT_NAMES = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'a',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'small',
  'label',
  'abbr',
  'cite',
  'code',
  'pre',
  'blockquote',
  'li',
  'dt',
  'dd',
  'figcaption',
]);

/**
 * VElement（またはその子孫）がテキストを含むか判定する。
 * - VText（非空白）があるか。
 * - v-html / v-text ディレクティブがあるか。
 * - テキスト系子要素があるか。
 * - 判定不能な場合は true（保守的にテキストありとみなす）。
 */
function elementContainsText(node: AST.VElement): boolean {
  if (!node.children) {
    return false;
  }

  for (const child of node.children) {
    // 非空白テキストノード
    if (child.type === 'VText' && child.value.trim() !== '') {
      return true;
    }

    // VExpressionContainer（マスタッシュ {{ }} 構文）
    if (child.type === 'VExpressionContainer') {
      return true;
    }

    // テキスト系子要素
    if (child.type === 'VElement' && TEXT_ELEMENT_NAMES.has(child.name)) {
      return true;
    }
  }

  // v-html / v-text ディレクティブ
  if (node.startTag && node.startTag.attributes) {
    for (const attr of node.startTag.attributes) {
      if (
        attr.directive &&
        attr.key &&
        attr.key.name &&
        (attr.key.name.name === 'html' || attr.key.name.name === 'text')
      ) {
        return true;
      }
    }
  }

  // 子VElementを再帰的に走査（テキスト系でないdiv等の中にテキストがある場合）
  for (const child of node.children) {
    if (child.type === 'VElement' && elementContainsText(child)) {
      return true;
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
        'Require border-radius on child elements with background inside overflow:hidden rounded containers for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      requireChildBorderRadius:
        'a child of a container with overflow:hidden + border-radius has a background color but no border-radius; ' +
        'dom-to-pptx loses the clipping of the parent overflow (fix: set border-radius directly on the child)',
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

        // 直接子要素を走査
        // img要素はスキップ（require-image-border-radius でカバー）
        if (node.name === 'img') {
          return;
        }

        // 子要素が背景を持つが border-radius がない場合に報告
        if (
          nodeHasBackground(node, ruleBlocks) &&
          !nodeHasBorderRadius(node, ruleBlocks)
        ) {
          // テキストを含まない要素はSVG化されてもテキスト消失しないため安全
          if (!elementContainsText(node)) return;

          context.report({
            node: vNodeAsRuleNode(node),
            messageId: 'requireChildBorderRadius',
          });
        }
      },
    });
  },
};

export default rule;
