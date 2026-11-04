import requireResolveAssetPath from './lib/rules/require-resolve-asset-path.ts';

const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
  configs: Record<string, unknown>;
} = {
  meta: {
    name: 'eslint-plugin-asset-path',
    version: '1.0.0',
  },
  rules: {
    'require-resolve-asset-path': requireResolveAssetPath,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: {
    'asset-path': plugin,
  },
  rules: {
    'asset-path/require-resolve-asset-path': 'error',
  },
};

export default plugin;
