import path from 'path';
import type { Rule } from 'eslint';
import { detectLayerWithDetails, isInExcludedDir, getDepthFromLayerDir } from '../utils/layer-detector.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce 2-layer architecture file placement rules',
      recommended: true,
    },
    schema: [],
    messages: {
      wrongExtension:
        'File extension "{{extension}}" is not allowed in {{layerName}}.\n' +
        'Allowed extensions: {{allowed}}',

      wrongNaming:
        'File name "{{fileName}}" does not follow naming convention.\n' +
        'Layer: {{layerName}}\n' +
        'Expected pattern: {{patternDescription}}',

      unknownLocation:
        'File "{{fileName}}" is not in any recognized layer directory.\n' +
        'Valid layer directories:\n{{validPaths}}',

      deepNesting:
        'File has too deep nesting ({{depth}} levels from {{layerDir}}/).\n' +
        'Maximum allowed: {{maxDepth}}',

      l2DirectoryForbidden:
        '`layouts/{{subdir}}/` ディレクトリは廃止されました（旧 Container 層）。\n' +
        'Layout ({{subdir}}.vue) に直接インライン化するか、Component (components/) として切り出してください。',
    },
  },

  create(context) {
    return {
      Program(node) {
        const filePath = context.filename;

        const l2Match = filePath.match(/\/layouts\/([^/]+)\/[^/]+\.vue$/);
        if (l2Match) {
          context.report({
            node,
            messageId: 'l2DirectoryForbidden',
            data: { subdir: l2Match[1] },
          });
          return;
        }

        const layerInfo = detectLayerWithDetails(filePath);

        if (!layerInfo) {
          if (isInExcludedDir(filePath)) {
            return;
          }

          const fileName = path.basename(filePath);
          const ext = path.extname(filePath);

          if (!['.vue', '.js', '.ts'].includes(ext)) {
            return;
          }

          const validPaths = [
            '  • Layer 1 (Layouts): layouts/*.vue',
            '  • Layer 3 (Components): components/**/*.vue',
          ];
          context.report({
            node,
            messageId: 'unknownLocation',
            data: {
              fileName,
              validPaths: validPaths.join('\n'),
            },
          });
          return;
        }

        const ext = path.extname(filePath);
        if (!layerInfo.allowedExtensions.includes(ext)) {
          context.report({
            node,
            messageId: 'wrongExtension',
            data: {
              extension: ext,
              layerName: layerInfo.name,
              allowed: layerInfo.allowedExtensions.join(', '),
            },
          });
          return;
        }

        const fileName = path.basename(filePath);
        if (!layerInfo.namingPattern.test(fileName)) {
          context.report({
            node,
            messageId: 'wrongNaming',
            data: {
              fileName,
              layerName: layerInfo.name,
              patternDescription: layerInfo.namingDescription,
            },
          });
        }

        const depth = getDepthFromLayerDir(filePath, layerInfo.layerDir);
        if (depth > layerInfo.maxDepthFromLayerDir) {
          context.report({
            node,
            messageId: 'deepNesting',
            data: {
              depth: String(depth),
              maxDepth: String(layerInfo.maxDepthFromLayerDir),
              layerDir: layerInfo.layerDir,
            },
          });
        }
      },
    };
  },
};

export default rule;
