import type { Rule } from 'eslint';

const SEPARATOR_REGEX = /^---\s*$/;

export function findExtraSeparators(text: string): number[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const lines = text.split('\n');

  if (!SEPARATOR_REGEX.test(lines[0])) {
    return [];
  }

  const separatorPositions: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (SEPARATOR_REGEX.test(lines[i])) {
      separatorPositions.push(i + 1);
    }
  }

  if (separatorPositions.length <= 1) {
    return [];
  }

  return separatorPositions.slice(1);
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow triple hyphen separator lines inside YAML frontmatter',
      recommended: true,
    },
    schema: [],
    messages: {
      tripleHyphenInFrontmatter:
        'extra `---` in the frontmatter (line {{line}}); ' +
        'Slidev mistakes it for a slide separator and the display breaks ' +
        '(fix: remove `---` from the YAML value or rephrase it)',
    },
  },

  create(context) {
    function checkForTripleHyphen(node: Rule.Node) {
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const extraSeparators = findExtraSeparators(text);
      for (const line of extraSeparators) {
        context.report({
          node,
          messageId: 'tripleHyphenInFrontmatter',
          data: { line: String(line) },
        });
      }
    }

    return {
      root: checkForTripleHyphen,
      Program: checkForTripleHyphen,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
