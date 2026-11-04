/**
 * ESLintカスタムルール: require-image-border-radius
 * 角丸コンテナ内の img 要素に border-radius がない場合を検出する。
 *
 * 2.1.1 で解消した点。1.x 当時の懸念に対する現状で、根拠位置は #1178 で更新した。
 *   解消したものは無い。
 *
 * 残る点:
 *   2.1.1 の dom-to-pptx.cjs `prepareRenderItem` L5766 は、img 自身に角丸が無いとき直接の親だけを見る。
 *   親が overflow:visible 以外で、親と img の寸法差が 5px 未満の場合に限り、親の角丸を継承する（L5775）。
 *   角丸は `getProcessedImage` L3716 で画像に組み込まれる。
 *   そのため中間要素（overflow:visible）を挟むと、角丸の無い画像が出力される。
 *   #1178 の計測では、中間 div を挟んだ img の四隅が不透明だった。
 *   img に直接 border-radius を付けた場合は、四隅が透明だった。
 *
 * 検出条件: border-radius の無い img の 2〜3 階層上に、画像コンテナ系クラス（image-block 等）がある。
 *   直接の親より上の階層が対象になる。
 *
 * 修正方法: img に直接 border-radius を追加するか、CSS で設定する。
 */

import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';
import {
  isPlainAttribute,
  isVBindDirective,
} from '../utils/vue-attr-helpers.ts';
import { getVueParserServices } from '../utils/parser-services.ts';
import { vNodeAsRuleNode } from '../utils/report-helpers.ts';


/**
 * style属性からborder-radiusを持つか判定
 */
function hasBorderRadiusStyle(node: AST.VElement): boolean {
  const attrs = node.startTag?.attributes ?? [];

  const styleAttr = attrs.find((attr) => {
    if (isPlainAttribute(attr) && attr.key.name === 'style') {
      return true;
    }
    if (isVBindDirective(attr, 'style')) {
      return true;
    }
    return false;
  });

  if (!styleAttr || !styleAttr.value) {
    return false;
  }

  // 静的style属性の値をチェック
  if (isPlainAttribute(styleAttr) && styleAttr.value) {
    return styleAttr.value.value.includes('border-radius');
  }

  // 動的style属性: ObjectExpressionの場合はborderRadiusプロパティの有無を確認
  if (
    !isPlainAttribute(styleAttr) &&
    styleAttr.value &&
    'expression' in styleAttr.value &&
    styleAttr.value.expression
  ) {
    const expr = styleAttr.value.expression;
    if (expr.type === 'ObjectExpression') {
      return expr.properties.some((prop) => {
        if (prop.type !== 'Property') return false;
        if (prop.key.type === 'Identifier') {
          return prop.key.name === 'borderRadius';
        }
        if (
          prop.key.type === 'Literal' &&
          typeof prop.key.value === 'string'
        ) {
          return prop.key.value === 'borderRadius';
        }
        return false;
      });
    }
  }

  // Identifier等（:style="varName"）は静的解析困難なのでtrueとみなす
  return true;
}

/**
 * class属性の値をセット（スペース区切り）で取得
 */
function getClassSet(
  node: AST.VElement | AST.VDocumentFragment | null,
): Set<string> | null {
  if (!node || node.type !== 'VElement') {
    return null;
  }
  const attrs = node.startTag?.attributes ?? [];

  const classAttr = attrs.find(
    (attr) =>
      isPlainAttribute(attr) && attr.key.name === 'class' && !!attr.value,
  );

  if (
    classAttr &&
    isPlainAttribute(classAttr) &&
    classAttr.value &&
    classAttr.value.type === 'VLiteral'
  ) {
    return new Set(classAttr.value.value.split(/\s+/).filter(Boolean));
  }

  return null;
}

const CONTAINER_CLASSES = [
  'image-block',
  'image-area',
  'adaptive-image',
  'hero-image',
];

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require border-radius on img elements inside rounded containers for PPTX compatibility',
      recommended: true,
    },
    schema: [],
    messages: {
      requireImageBorderRadius:
        'img要素にborder-radiusがありません。dom-to-pptxは親要素の角丸を継承しない場合があります。imgに直接border-radiusを追加するか、CSSで設定してください。',
    },
  },

  create(context) {
    const parserServices = getVueParserServices(context);
    if (!parserServices.defineTemplateBodyVisitor) {
      return {};
    }

    return parserServices.defineTemplateBodyVisitor({
      VElement(node: AST.VElement) {
        if (node.name !== 'img') {
          return;
        }

        // img自体にborder-radiusがある場合はOK
        if (hasBorderRadiusStyle(node)) {
          return;
        }

        // 親要素をチェック
        let parent: AST.VElement | AST.VDocumentFragment | null = node.parent;
        let depth = 0;
        const maxDepth = 3; // 3階層まで確認

        while (parent && parent.type === 'VElement' && depth < maxDepth) {
          const parentClassSet = getClassSet(parent);

          // 親にimage-block, image-area, adaptive-imageなどの画像関連クラスがあるか
          if (
            parentClassSet &&
            CONTAINER_CLASSES.some((cls) => parentClassSet.has(cls))
          ) {
            // 画像コンテナ系クラスが見つかった。
            // img が直接の子でない場合（中間要素がある場合）は警告する。
            if (depth > 0) {
              context.report({
                node: vNodeAsRuleNode(node),
                messageId: 'requireImageBorderRadius',
              });
              return;
            }
          }

          parent = parent.parent;
          depth++;
        }
      },
    });
  },
};

export default rule;
