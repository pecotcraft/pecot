import type { Rule } from 'eslint';

const SEPARATOR_REGEX = /^---\s*$/;

export function hasContentBeforeFrontmatter(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }

  const lines = text.split('\n');

  if (SEPARATOR_REGEX.test(lines[0])) {
    return false;
  }

  for (let i = 1; i < lines.length; i++) {
    if (SEPARATOR_REGEX.test(lines[i])) {
      return true;
    }
  }

  return false;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow content before frontmatter in Slidev pages directory',
      recommended: true,
    },
    schema: [],
    messages: {
      contentBeforeFrontmatter:
        'frontmatter（---）の前にコンテンツがあります。Slidevが白画面になる原因となるため、frontmatterをファイル先頭に配置してください。',
    },
  },

  create(context) {
    function checkForContentBeforeFrontmatter(node: Rule.Node) {
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      if (hasContentBeforeFrontmatter(text)) {
        context.report({
          node,
          messageId: 'contentBeforeFrontmatter',
        });
      }
    }

    return {
      root: checkForContentBeforeFrontmatter,
      Program: checkForContentBeforeFrontmatter,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
