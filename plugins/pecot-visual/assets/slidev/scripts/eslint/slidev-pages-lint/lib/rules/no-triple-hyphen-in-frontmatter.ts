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
        'フロントマター内に余分な `---` が含まれています（{{line}}行目）。' +
        'Slidevがスライド区切りと誤認し、表示が崩れる原因になります。' +
        'YAML値から `---` を除去するか、別の表現に置き換えてください。',
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
