import type { Rule } from 'eslint';
import path from 'path';
import { findSlidesFile, getSlidesEntries } from '../utils/slides-loader.ts';
import { resolveFilename, isReferenceFile } from '../utils/page-file.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require pages files to be referenced in slides.md',
      recommended: true,
    },
    schema: [],
    messages: {
      missingEntry:
        'this page file is not in slides.md (fix: add a src: entry to slides.md)',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const filePath = resolveFilename(context);
      if (isReferenceFile(filePath)) {
        return;
      }

      const slidesFile = findSlidesFile(filePath);
      if (!slidesFile) {
        return;
      }

      const entries = getSlidesEntries(slidesFile);
      const absoluteFilePath = path.resolve(filePath);

      if (!entries.has(absoluteFilePath)) {
        context.report({
          node,
          messageId: 'missingEntry',
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
