import type { Rule } from 'eslint';
import { parseFrontmatter, readThemeSettings, loadLayoutReference, getClicksValidation } from '@v-slidev/eslint-shared';
import type { FrontmatterBase } from '@v-slidev/eslint-shared';
import {
  validateClicks,
  validateClicksCount,
  validateClicksRequired,
  type ClicksValidationResult,
} from '../utils/clicks-validator.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Validate clicks frontmatter property against layout reference definitions',
      recommended: true,
    },
    schema: [],
    messages: {
      missingClicks:
        '{{count}} {{sourceProp}} ({{perPage}} per page) require clicks: {{expected}}; without it, pages are dropped in PPTX conversion',
      incorrectClicks:
        'clicks: {{actual}} is incorrect; {{count}} {{sourceProp}} ({{perPage}} per page) (fix: set clicks: {{expected}})',
      unnecessaryClicks:
        'clicks: {{actual}} is set, but {{count}} {{sourceProp}} ({{perPage}} per page) need no paging (fix: remove clicks or set it to 0)',
      missingClicksCount:
        '{{count}} {{sourceProp}} require clicks: {{expected}}',
      incorrectClicksCount:
        'clicks: {{actual}} is incorrect; {{count}} {{sourceProp}} (fix: set clicks: {{expected}})',
      missingClicksRequired:
        'the {{matchedProps}} layout requires clicks: {{minClicks}} or more',
      insufficientClicks:
        'clicks: {{actual}} is too small; the {{matchedProps}} layout requires clicks: {{minClicks}} or more (fix: raise clicks to at least {{minClicks}})',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const frontmatter = parseFrontmatter(text) as (FrontmatterBase & { clicks?: number }) | null;
      if (!frontmatter || !frontmatter.layout) {
        return;
      }

      const { referencesDirectories } = readThemeSettings(context);
      if (referencesDirectories.length === 0) {
        return;
      }

      const layoutName = frontmatter.layout;
      const reference = loadLayoutReference(referencesDirectories, layoutName);
      if (!reference) {
        return;
      }

      const validation = getClicksValidation(reference);
      if (!validation) {
        return;
      }

      let result: ClicksValidationResult;
      const actualClicks = frontmatter.clicks;

      if (validation.type === 'required') {
        let minClicks = validation.min_clicks ?? 1;
        const scrollProp = validation.scroll_prop;
        if (scrollProp) {
          const scrollArray = frontmatter[scrollProp];
          if (Array.isArray(scrollArray) && scrollArray.length > 0) {
            minClicks = Math.max(minClicks, scrollArray.length);
          }
        }
        result = validateClicksRequired({
          actualClicks,
          matchedProps: layoutName,
          minClicks,
        });
      } else {
        const sourcePropName = validation.source_prop as string;
        const sourceArray = frontmatter[sourcePropName];
        if (!Array.isArray(sourceArray)) {
          return;
        }

        if (validation.type === 'pagination') {
          result = validateClicks({
            actualClicks,
            itemCount: sourceArray.length,
            perPage: validation.per_page as number,
            sourceProp: sourcePropName,
          });
        } else if (validation.type === 'count') {
          result = validateClicksCount({
            actualClicks,
            itemCount: sourceArray.length,
            sourceProp: sourcePropName,
            offset: validation.offset ?? 0,
          });
        } else {
          return;
        }
      }

      if (!result.valid && result.messageId) {
        context.report({
          node,
          messageId: result.messageId,
          data: result.data,
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
