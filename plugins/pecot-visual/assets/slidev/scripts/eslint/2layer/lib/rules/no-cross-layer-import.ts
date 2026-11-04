import type { Rule } from 'eslint';
import {
  detectLayer,
  resolveImportPath,
  isAllowedImport,
  getAllowedLayersDescription,
} from '../utils/layer-detector.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce 2-layer architecture dependency rules',
      recommended: true,
    },
    schema: [],
    messages: {
      illegalImport:
        'Layer {{fromLayer}} ({{fromName}}) cannot import from Layer {{toLayer}} ({{toName}}). Allowed imports: {{allowed}}',
      l1ToL1:
        'Layout 同士の import は禁止です（{{fromName}} → {{toName}}）。共通要素は Component に切り出してください。',
    },
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const currentFilePath = context.filename;

        const fromLayer = detectLayer(currentFilePath);
        if (!fromLayer) {
          return;
        }

        const importPath = node.source.value;
        if (typeof importPath !== 'string') {
          return;
        }
        const resolvedPath = resolveImportPath(importPath, currentFilePath);
        if (!resolvedPath) {
          return;
        }

        const toLayer = detectLayer(resolvedPath);
        if (!toLayer) {
          return;
        }

        if (fromLayer.id === 1 && toLayer.id === 1) {
          context.report({
            node,
            messageId: 'l1ToL1',
            data: {
              fromName: fromLayer.name,
              toName: toLayer.name,
            },
          });
          return;
        }

        if (!isAllowedImport(fromLayer.id, toLayer.id)) {
          context.report({
            node,
            messageId: 'illegalImport',
            data: {
              fromLayer: String(fromLayer.id),
              fromName: fromLayer.name,
              toLayer: String(toLayer.id),
              toName: toLayer.name,
              allowed: getAllowedLayersDescription(fromLayer.id),
            },
          });
        }
      },
    };
  },
};

export default rule;
