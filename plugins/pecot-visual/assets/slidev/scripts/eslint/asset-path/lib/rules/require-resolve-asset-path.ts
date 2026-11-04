import type { Rule } from 'eslint';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require resolveAssetPath() wrapper for fetch() calls with asset paths',
      recommended: true,
    },
    schema: [],
    messages: {
      absolutePathWithoutResolve:
        'fetch() with absolute path "{{path}}" must use resolveAssetPath(). Use fetch(resolveAssetPath(\'{{path}}\')) instead.',
      missingResolveAssetPath:
        'fetch() argument should be wrapped with resolveAssetPath() to support subdirectory deployment.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isFetch =
          (callee.type === 'Identifier' && callee.name === 'fetch') ||
          (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'window' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'fetch');

        if (!isFetch) {
          return;
        }

        if (node.arguments.length === 0) {
          return;
        }

        const firstArg = node.arguments[0];

        if (
          firstArg.type === 'CallExpression' &&
          firstArg.callee.type === 'Identifier' &&
          firstArg.callee.name === 'resolveAssetPath'
        ) {
          return;
        }

        if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
          const value = firstArg.value;

          if (value.startsWith('http://') || value.startsWith('https://')) {
            return;
          }

          if (value.startsWith('/')) {
            context.report({
              node,
              messageId: 'absolutePathWithoutResolve',
              data: { path: value },
            });
            return;
          }
        }

        if (firstArg.type === 'TemplateLiteral') {
          if (firstArg.quasis.length > 0) {
            const firstQuasi = firstArg.quasis[0].value.raw;
            if (firstQuasi.startsWith('http://') || firstQuasi.startsWith('https://')) {
              return;
            }

            if (firstQuasi.startsWith('/')) {
              context.report({
                node,
                messageId: 'absolutePathWithoutResolve',
                data: { path: firstQuasi + '...' },
              });
              return;
            }
          }
        }

        if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
          context.report({
            node,
            messageId: 'missingResolveAssetPath',
          });
          return;
        }

        if (firstArg.type === 'TemplateLiteral') {
          context.report({
            node,
            messageId: 'missingResolveAssetPath',
          });
          return;
        }

        context.report({
          node,
          messageId: 'missingResolveAssetPath',
        });
      },
    };
  },
};

export default rule;
