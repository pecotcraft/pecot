import type { Rule } from 'eslint';

// The `(node: never, ...) => void` shape lets the consumer declare narrower parameter types.
// Examples are `(node: AST.VElement)` and `(node: ESTree.Program)`.
// TypeScript then accepts the assignment (contravariant input).
export interface VueParserServices {
  defineTemplateBodyVisitor?(
    templateVisitor: Record<string, (node: never, ...rest: unknown[]) => void>,
    scriptVisitor?: Record<string, (node: never, ...rest: unknown[]) => void>,
  ): Rule.RuleListener;
}

export function getVueParserServices(
  context: Rule.RuleContext,
): VueParserServices {
  return (context.sourceCode.parserServices ?? {}) as VueParserServices;
}
