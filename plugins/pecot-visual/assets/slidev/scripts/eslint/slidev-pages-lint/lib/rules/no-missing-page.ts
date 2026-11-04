import type { Rule } from 'eslint';
import fs from 'fs';
import path from 'path';
import { resolveFilename } from '../utils/page-file.ts';

const SRC_LINE_REGEX = /^\s*src:\s+(.+)/;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow src references to non-existent page files in slides.md',
      recommended: true,
    },
    schema: [],
    messages: {
      missingPage: 'src: で参照されたファイルが存在しません: {{filePath}}',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const filePath = resolveFilename(context);
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const slidesDir = path.dirname(path.resolve(filePath));
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const match = SRC_LINE_REGEX.exec(lines[i]);
        if (!match) {
          continue;
        }
        const srcValue = match[1].trim();
        const absolutePath = path.resolve(slidesDir, srcValue);

        if (!fs.existsSync(absolutePath)) {
          context.report({
            node,
            loc: { line: i + 1, column: 0 },
            messageId: 'missingPage',
            data: { filePath: srcValue },
          });
        }
      }
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
