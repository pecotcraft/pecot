import oneSlidePerFile from './lib/rules/one-slide-per-file.ts';
import noContentBeforeFrontmatter from './lib/rules/no-content-before-frontmatter.ts';
import validateClicks from './lib/rules/validate-clicks.ts';
import noUnknownProps from './lib/rules/no-unknown-props.ts';
import requireSlidesEntry from './lib/rules/require-slides-entry.ts';
import noMissingPage from './lib/rules/no-missing-page.ts';
import noTripleHyphenInFrontmatter from './lib/rules/no-triple-hyphen-in-frontmatter.ts';
import noNumericFilenamePrefix from './lib/rules/no-numeric-filename-prefix.ts';
import noNumericAssetPrefix from './lib/rules/no-numeric-asset-prefix.ts';
import requireMatchingLength from './lib/rules/require-matching-length.ts';
import noMissingMarkerCell from './lib/rules/no-missing-marker-cell.ts';
import noScaledDrawio from './lib/rules/no-scaled-drawio.ts';

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
    name: 'eslint-plugin-slidev-pages-lint',
    version: '1.8.0',
  },
  rules: {
    'one-slide-per-file': oneSlidePerFile,
    'no-content-before-frontmatter': noContentBeforeFrontmatter,
    'validate-clicks': validateClicks,
    'no-unknown-props': noUnknownProps,
    'require-slides-entry': requireSlidesEntry,
    'no-missing-page': noMissingPage,
    'no-triple-hyphen-in-frontmatter': noTripleHyphenInFrontmatter,
    'no-numeric-filename-prefix': noNumericFilenamePrefix,
    'no-numeric-asset-prefix': noNumericAssetPrefix,
    'require-matching-length': requireMatchingLength,
    'no-missing-marker-cell': noMissingMarkerCell,
    'no-scaled-drawio': noScaledDrawio,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: {
    'slidev-pages-lint': plugin,
  },
  rules: {
    'slidev-pages-lint/one-slide-per-file': 'error',
    'slidev-pages-lint/no-content-before-frontmatter': 'error',
    'slidev-pages-lint/validate-clicks': 'error',
    'slidev-pages-lint/no-unknown-props': 'error',
    'slidev-pages-lint/require-slides-entry': 'error',
    'slidev-pages-lint/no-missing-page': 'error',
    'slidev-pages-lint/no-triple-hyphen-in-frontmatter': 'error',
    'slidev-pages-lint/no-numeric-filename-prefix': 'error',
    'slidev-pages-lint/no-numeric-asset-prefix': 'error',
    'slidev-pages-lint/require-matching-length': 'error',
    'slidev-pages-lint/no-missing-marker-cell': 'error',
    'slidev-pages-lint/no-scaled-drawio': 'error',
  },
};

export default plugin;
