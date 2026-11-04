import type { AST } from 'vue-eslint-parser';

export function isPlainAttribute(
  attr: AST.VAttribute | AST.VDirective,
): attr is AST.VAttribute {
  return !attr.directive;
}

export function isVBindDirective(
  attr: AST.VAttribute | AST.VDirective,
  argName?: string,
): attr is AST.VDirective {
  if (!attr.directive) return false;
  if (attr.key.name.name !== 'bind') return false;
  if (argName === undefined) return true;
  const arg = attr.key.argument;
  return arg?.type === 'VIdentifier' && arg.name === argName;
}

export function isVShowDirective(
  attr: AST.VAttribute | AST.VDirective,
): attr is AST.VDirective {
  if (!attr.directive) return false;
  return attr.key.name.name === 'show';
}

export function getStaticClassNames(node: AST.VElement): string[] {
  const attrs = node.startTag?.attributes ?? [];
  for (const attr of attrs) {
    if (isPlainAttribute(attr) && attr.key.name === 'class' && attr.value) {
      return attr.value.value.split(/\s+/).filter(Boolean);
    }
  }
  return [];
}
