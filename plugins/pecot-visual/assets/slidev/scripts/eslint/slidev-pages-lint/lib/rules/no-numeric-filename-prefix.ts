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
        'ページファイル名が数字で始まっています: {{fileName}}。スライドの順序は slides.md の src: エントリの並びだけで管理するため、ページファイル名を数字で始めないでください。数字で始まらない英語名（例: cover.md）にリネームし、slides.md の src: を更新してください。',
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
