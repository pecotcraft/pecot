import type { Rule } from 'eslint';

const SEPARATOR_REGEX = /^---\s*$/;

function countFrontmatterBlocks(text: string): number {
  if (typeof text !== 'string') {
    return 0;
  }

  const lines = text.split('\n');
  let count = 0;
  let inFrontmatter = false;
  let frontmatterStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSeparator = SEPARATOR_REGEX.test(line);

    if (isSeparator) {
      if (!frontmatterStarted) {
        frontmatterStarted = true;
        inFrontmatter = true;
      } else if (inFrontmatter) {
        inFrontmatter = false;
        count++;
      } else {
        frontmatterStarted = true;
        inFrontmatter = true;
      }
    }
  }

  return count;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce one slide per file in Slidev pages directory',
      recommended: true,
    },
    schema: [],
    messages: {
      multipleSlides:
        'multiple slides in one file (fix: use one slide per file under pages/)',
    },
  },

  create(context) {
    function checkForMultipleSlides(node: Rule.Node) {
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const frontmatterCount = countFrontmatterBlocks(text);

      if (frontmatterCount >= 2) {
        context.report({
          node,
          messageId: 'multipleSlides',
        });
      }
    }

    return {
      root: checkForMultipleSlides,
      Program: checkForMultipleSlides,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
