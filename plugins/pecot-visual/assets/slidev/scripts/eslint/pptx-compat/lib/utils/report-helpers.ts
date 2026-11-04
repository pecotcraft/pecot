import type { Rule } from 'eslint';
import type * as ESTree from 'estree';
import type { AST } from 'vue-eslint-parser';

// Bridges the `vue-eslint-parser` AST nodes to ESLint's `Rule.Node` shape.
// ESTree script-side nodes surfaced by `defineTemplateBodyVisitor` are bridged too.
// They can then be passed to `context.report({ node })` without per-call casts.
export function vNodeAsRuleNode(node: AST.VNode | ESTree.Node): Rule.Node {
  return node as unknown as Rule.Node;
}
