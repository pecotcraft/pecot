import noCrossLayerImport from './lib/rules/no-cross-layer-import.ts';
import layerFilePlacement from './lib/rules/layer-file-placement.ts';

const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
  configs: Record<string, unknown>;
} = {
  meta: {
    name: 'eslint-plugin-2layer',
    version: '2.0.0',
  },
  rules: {
    'no-cross-layer-import': noCrossLayerImport,
    'layer-file-placement': layerFilePlacement,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: {
    '2layer': plugin,
  },
  rules: {
    '2layer/no-cross-layer-import': 'error',
    '2layer/layer-file-placement': 'error',
  },
};

export default plugin;
