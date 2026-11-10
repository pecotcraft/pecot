/**
 * ESLintカスタムルール: require-table-cell-background
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   1.x 当時は、背景無指定のセルが親の背景を継承しない前提だった。
 *   そのため、全ての td / th に背景の明示を求めていた。
 *   2.1.1 では背景無指定のセルは透明塗り（alpha 0）で出力され、背面の図形が透けて見える。
 *   table 自身の背景は dom-to-pptx.cjs `prepareRenderItem` L5463 で、表の背面の図形として描かれる。
 *   表を包む外側の要素の背景も、独立した図形として背面に出る。
 *   #1178 の計測では、この 2 つの形は、セルに同色を明示した場合と同じ見え方になった。
 *   （compare-pptx 両方向 PASS、セル塗りのみ透明か明示かの差）。
 *
 * 残る点:
 *   2.1.1 cjs `extractTableData` L2174 は、セル背景を `flattenColor` に通す。
 *   しかし `flattenColor` L2543 は opacity が 0 か 1 なら即 return し、透明セルに祖先の背景を合成しない。
 *   さらに `prepareRenderItem` L5482 で table の再帰が止まる。
 *   そのため tr / thead / tbody / tfoot の背景は、どこにも描かれない。
 *   （#1178 の計測: tr / tbody に背景を置いた表は、セルが白に見える）。
 *   colgroup / col の背景も、セルの computed 背景には現れず、図形も作られない。
 *   （#1178 の計測: col / colgroup に背景を置いた表は、セル塗りが alpha 0 で、背面の図形も無い）。
 *   なお table 自身の背景図形は、ブラウザで計測した table 矩形の寸法で描かれる。
 *   そのため PPTX 側の行高（自動）と、数 px ずれることがある（#1178 の LibreOffice 描画で 2px）。
 *
 * 検出条件: td / th に背景が無く、動的な :style / :class も無く、次のどちらかに背景がある。
 *   背景とは、インライン style・クラスの background-color または background を指す。
 *   - セルから最も近い table までの祖先（tr / thead / tbody / tfoot）。
 *   - 最も近い table の colgroup / col。
 *   祖先・列側の背景は、次の 3 つで判定する。
 *   - インライン style。
 *   - :style のオブジェクトリテラルのキー（background / backgroundColor）。
 *   - 最後の複合セレクタがそのクラスを含む <style> のルール。
 *   値が none / transparent の宣言は背景とみなさない。
 *   静的に読めない :style は報告しない。
 *
 * 修正方法: 祖先の行要素・列要素と同じ background-color を各セルに明示する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  extractStyleBlocks,
  extractRuleBlocks,
  classHasProperty,
} from '../utils/css-style-parser.ts';
import type { StyleBlock, RuleBlock } from '../utils/css-style-parser.ts';
import {
  isPlainAttribute,
  isVBindDirective,
  getStaticClassNames,
} from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


const TABLE_CELL_ELEMENTS = new Set(['td', 'th']);
const ROW_GROUP_ELEMENTS = new Set(['tr', 'thead', 'tbody', 'tfoot']);
const BACKGROUND_PROPERTIES = new Set(['background', 'background-color']);
const BACKGROUND_OBJECT_KEYS = new Set(['background', 'backgroundColor', 'background-color']);
const NO_BACKGROUND_VALUES = new Set(['none', 'transparent']);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 宣言列（style 属性値やルール本体）に背景の宣言があるか。値が none / transparent だけの宣言は除く
 */
function declarationsHaveBackground(declarations: string): boolean {
  return declarations.split(';').some((decl) => {
    const colon = decl.indexOf(':');
    if (colon === -1) return false;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (!BACKGROUND_PROPERTIES.has(prop)) return false;
    const tokens = decl
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.some((token) => !NO_BACKGROUND_VALUES.has(token));
  });
}

/**
 * 要素の静的 style 属性に背景の宣言があるか
 */
function staticStyleHasBackground(node: AST.VElement): boolean {
  return node.startTag.attributes.some(
    (attr) =>
      isPlainAttribute(attr) &&
      attr.key.name === 'style' &&
      attr.value !== null &&
      declarationsHaveBackground(attr.value.value),
  );
}

/**
 * :style の式がオブジェクトリテラルで、背景のキーを持つか。静的に読めない式は false
 */
function boundStyleObjectHasBackground(node: AST.VElement): boolean {
  return node.startTag.attributes.some((attr) => {
    if (!isVBindDirective(attr, 'style')) return false;
    const expression = attr.value?.expression;
    if (!expression || expression.type !== 'ObjectExpression') return false;
    return expression.properties.some((prop) => {
      if (prop.type !== 'Property' || prop.computed) return false;
      const key = prop.key;
      if (key.type === 'Identifier') return BACKGROUND_OBJECT_KEYS.has(key.name);
      return key.type === 'Literal' && typeof key.value === 'string' && BACKGROUND_OBJECT_KEYS.has(key.value);
    });
  });
}

/**
 * 要素に動的な :style / :class があるか（セル側で背景の可能性ありとして対象外にする）
 */
function hasDynamicStyleOrClass(node: AST.VElement): boolean {
  return node.startTag.attributes.some(
    (attr) => isVBindDirective(attr, 'style') || isVBindDirective(attr, 'class'),
  );
}

/**
 * セレクタの最後の複合セレクタ（子孫・子・兄弟結合子の右端）
 */
function lastCompoundSelector(selector: string): string {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/);
  return parts[parts.length - 1];
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require explicit background-color on table cells whose tr / thead / tbody / tfoot ancestor or col / colgroup has a background, for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      requireTableCellBackground:
        'table cell ({{tag}}) has no background-color while <{{ancestor}}> has a background; ' +
        'PPTX does not output backgrounds of tr / thead / tbody / tfoot / col / colgroup, so the cell becomes transparent ' +
        '(fix: set the same background-color on each cell)',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    let styleBlocks: StyleBlock[] | null = null;
    let ruleBlocks: RuleBlock[] | null = null;

    /**
     * スタイルブロックを遅延取得
     */
    function getStyleBlocks(): StyleBlock[] {
      if (styleBlocks === null) {
        const sourceCode = context.sourceCode;
        styleBlocks = extractStyleBlocks(sourceCode.getText());
      }
      return styleBlocks;
    }

    /**
     * <style> 内の全ルールを遅延取得
     */
    function getRuleBlocks(): RuleBlock[] {
      if (ruleBlocks === null) {
        ruleBlocks = getStyleBlocks().flatMap((block) => extractRuleBlocks(block.css));
      }
      return ruleBlocks;
    }

    /**
     * セルのクラスが <style> 内で背景（background-color / background）を持つか
     */
    function cellClassHasBackground(node: AST.VElement): boolean {
      const blocks = getStyleBlocks();
      return getStaticClassNames(node).some((className) =>
        blocks.some((block) =>
          ['background-color', 'background'].some((prop) =>
            classHasProperty(block.css, className, prop),
          ),
        ),
      );
    }

    /**
     * 要素自身を対象とするクラスのルール（カンマ区切り各セレクタの最後の複合セレクタが
     * そのクラスを含む）に背景の宣言があるか
     */
    function ownClassRuleHasBackground(node: AST.VElement): boolean {
      const classNames = getStaticClassNames(node);
      if (classNames.length === 0) return false;
      const classPatterns = classNames.map(
        (className) => new RegExp(`\\.${escapeRegex(className)}(?![\\w-])`),
      );
      return getRuleBlocks().some(
        (rule) =>
          declarationsHaveBackground(rule.body) &&
          rule.selector.split(',').some((selector) => {
            const compound = lastCompoundSelector(selector);
            return classPatterns.some((pattern) => pattern.test(compound));
          }),
      );
    }

    /**
     * 祖先・列要素に背景があるか（静的 style・:style のオブジェクトリテラル・自身を対象とするクラス）
     */
    function elementHasBackground(node: AST.VElement): boolean {
      return (
        staticStyleHasBackground(node) ||
        boundStyleObjectHasBackground(node) ||
        ownClassRuleHasBackground(node)
      );
    }

    /**
     * セルから最も近い table までの祖先で、背景を持つ tr / thead / tbody / tfoot の要素名。
     * 祖先に無ければ、その table の colgroup / col で背景を持つ要素名
     */
    function findAncestorWithBackground(cell: AST.VElement): string | null {
      let current = cell.parent;
      while (current.type === 'VElement' && current.name !== 'table') {
        if (ROW_GROUP_ELEMENTS.has(current.name) && elementHasBackground(current)) {
          return current.name;
        }
        current = current.parent;
      }
      if (current.type !== 'VElement') {
        return null;
      }
      return findColumnWithBackground(current);
    }

    /**
     * table 直下の colgroup / col と colgroup 内の col で、背景を持つ要素名
     */
    function findColumnWithBackground(table: AST.VElement): string | null {
      for (const child of table.children) {
        if (child.type !== 'VElement') continue;
        if (child.name === 'col' && elementHasBackground(child)) {
          return 'col';
        }
        if (child.name !== 'colgroup') continue;
        if (elementHasBackground(child)) {
          return 'colgroup';
        }
        const col = child.children.find(
          (grandChild): grandChild is AST.VElement =>
            grandChild.type === 'VElement' &&
            grandChild.name === 'col' &&
            elementHasBackground(grandChild),
        );
        if (col) {
          return 'col';
        }
      }
      return null;
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VElement) {
        if (!TABLE_CELL_ELEMENTS.has(node.name)) {
          return;
        }

        // セル自身に背景があるか、動的な :style / :class で背景の可能性があれば対象外
        if (
          staticStyleHasBackground(node) ||
          hasDynamicStyleOrClass(node) ||
          cellClassHasBackground(node)
        ) {
          return;
        }

        const ancestor = findAncestorWithBackground(node);
        if (ancestor === null) {
          return;
        }

        context.report({
          node: vNodeAsRuleNode(node),
          messageId: 'requireTableCellBackground',
          data: {
            tag: node.name,
            ancestor,
          },
        });
      },
    });
  },
};

export default rule;
