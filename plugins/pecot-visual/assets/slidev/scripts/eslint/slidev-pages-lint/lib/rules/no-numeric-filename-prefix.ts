import type { Rule } from 'eslint';
import path from 'path';
import { resolveFilename, isReferenceFile } from '../utils/page-file.ts';

const LEADING_DIGIT_REGEX = /^\d/;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow pages file names starting with a digit',
      recommended: true,
    },
    schema: [],
    messages: {
      numericFilenamePrefix:
        'page file name starts with a digit: {{fileName}}; the slide order is managed only by the order of the src: entries in slides.md (fix: rename it to an English name that does not start with a digit, such as cover.md, and update src: in slides.md)',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const filePath = resolveFilename(context);
      if (isReferenceFile(filePath)) {
        return;
      }

      const fileName = path.basename(path.normalize(filePath));
      const stem = fileName.slice(0, fileName.length - path.extname(fileName).length);

      if (LEADING_DIGIT_REGEX.test(stem)) {
        context.report({
          node,
          loc: { line: 1, column: 0 },
          messageId: 'numericFilenamePrefix',
          data: { fileName },
        });
      }
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
