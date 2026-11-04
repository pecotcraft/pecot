import type { AST } from 'vue-eslint-parser';
import { isPlainAttribute, isVBindDirective } from './vue-attr-helpers.ts';

export function hasPptxImageAncestor(node: AST.VElement): boolean {
  let current: AST.VElement | AST.VDocumentFragment | null = node;

  while (current && current.type === 'VElement') {
    const attrs = current.startTag?.attributes ?? [];
    for (const attr of attrs) {
      if (isPlainAttribute(attr) && attr.key.name === 'data-pptx-image') {
        return true;
      }
    }
    current = current.parent;
  }

  return false;
}

export function collectPptxImageClasses(rootNode: AST.VElement): Set<string> {
  const classes = new Set<string>();

  function walk(
    node: AST.VElement | AST.VText | AST.VExpressionContainer,
  ): void {
    if (node.type !== 'VElement') {
      return;
    }

    const attrs = node.startTag?.attributes ?? [];
    const hasPptxImage = attrs.some(
      (a) => isPlainAttribute(a) && a.key.name === 'data-pptx-image',
    );

    if (hasPptxImage) {
      collectDescendantClasses(node, classes);
      return;
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  for (const child of rootNode.children) {
    walk(child);
  }

  return classes;
}

function collectDescendantClasses(
  node: AST.VElement,
  classes: Set<string>,
): void {
  const attrs = node.startTag?.attributes ?? [];
  for (const attr of attrs) {
    if (
      isPlainAttribute(attr) &&
      attr.key.name === 'class' &&
      attr.value &&
      attr.value.value
    ) {
      for (const cn of attr.value.value.split(/\s+/).filter(Boolean)) {
        classes.add(cn);
      }
    }

    if (
      isVBindDirective(attr, 'class') &&
      attr.value &&
      attr.value.expression
    ) {
      collectClassesFromExpression(attr.value.expression, classes);
    }
  }

  for (const child of node.children) {
    if (child.type === 'VElement') {
      collectDescendantClasses(child, classes);
    }
  }
}

type ClassExpression =
  | AST.ESLintExpression
  | AST.VFilterSequenceExpression
  | AST.VForExpression
  | AST.VOnExpression
  | AST.VSlotScopeExpression
  | AST.VGenericExpression
  | AST.ESLintSpreadElement
  | null;

function collectClassesFromExpression(
  expr: ClassExpression,
  classes: Set<string>,
): void {
  if (!expr) return;

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
      if (name) {
        classes.add(name);
      }
    }
  } else if (expr.type === 'ArrayExpression') {
    for (const el of expr.elements) {
      if (!el) continue;
      if (el.type === 'Literal' && typeof el.value === 'string') {
        classes.add(el.value);
      } else {
        collectClassesFromExpression(el, classes);
      }
    }
  }
}
