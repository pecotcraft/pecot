import maxChars from './lib/rules/max-chars.ts';
import textlint from './lib/rules/textlint.ts';
import textlintBody from './lib/rules/textlint-body.ts';

interface PluginConfig {
  plugins: Record<string, unknown>;
  rules: Record<string, string>;
}

interface Plugin {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
  configs: Record<string, PluginConfig>;
}

const plugin: Plugin = {
  meta: {
    name: 'eslint-plugin-text-constraints',
    version: '1.0.0',
  },
  rules: {
    'max-chars': maxChars,
    textlint,
    'textlint-body': textlintBody,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: {
    'text-constraints': plugin,
  },
  rules: {
    'text-constraints/max-chars': 'error',
    'text-constraints/textlint': 'error',
    'text-constraints/textlint-body': 'error',
  },
};

export default plugin;
