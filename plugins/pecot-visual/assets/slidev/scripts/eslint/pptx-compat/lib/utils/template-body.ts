import type { Rule } from 'eslint';
import type { AST } from 'vue-eslint-parser';

export function getTemplateBody(
  context: Rule.RuleContext,
): AST.VElement | undefined {
  return (context.sourceCode.ast as unknown as AST.ESLintProgram).templateBody;
}
