import noSpanTextWrapper from './lib/rules/no-span-text-wrapper.ts';
import noInsetShadow from './lib/rules/no-inset-shadow.ts';
import requireTableCellBackground from './lib/rules/require-table-cell-background.ts';
import noTableComplexContent from './lib/rules/no-table-complex-content.ts';
import requireImageBorderRadius from './lib/rules/require-image-border-radius.ts';
import noCompositeBorderOnText from './lib/rules/no-composite-border-on-text.ts';
import noLineHeightCentering from './lib/rules/no-line-height-centering.ts';
import requireChildBorderRadiusInRoundedContainer from './lib/rules/require-child-border-radius-in-rounded-container.ts';
import noShrinkwrapAbsolute from './lib/rules/no-shrinkwrap-absolute.ts';
import noDecorativeBarElement from './lib/rules/no-decorative-bar-element.ts';
import requireAbsoluteLast from './lib/rules/require-absolute-last.ts';
import noCssFilter from './lib/rules/no-css-filter.ts';
import noOverflowHiddenWithBgChildren from './lib/rules/no-overflow-hidden-with-bg-children.ts';
import noDirectiveOnBr from './lib/rules/no-directive-on-br.ts';

const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
  configs: Record<string, unknown>;
} = {
  meta: {
    name: 'eslint-plugin-pptx-compat',
    version: '1.8.0',
  },
  rules: {
    'no-span-text-wrapper': noSpanTextWrapper,
    'no-inset-shadow': noInsetShadow,
    'require-table-cell-background': requireTableCellBackground,
    'no-table-complex-content': noTableComplexContent,
    'require-image-border-radius': requireImageBorderRadius,
    'no-composite-border-on-text': noCompositeBorderOnText,
    'no-line-height-centering': noLineHeightCentering,
    'require-child-border-radius-in-rounded-container':
      requireChildBorderRadiusInRoundedContainer,
    'no-shrinkwrap-absolute': noShrinkwrapAbsolute,
    'no-decorative-bar-element': noDecorativeBarElement,
    'require-absolute-last': requireAbsoluteLast,
    'no-css-filter': noCssFilter,
    'no-overflow-hidden-with-bg-children': noOverflowHiddenWithBgChildren,
    'no-directive-on-br': noDirectiveOnBr,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: {
    'pptx-compat': plugin,
  },
  rules: {
    'pptx-compat/no-span-text-wrapper': 'error',
    'pptx-compat/no-inset-shadow': 'error',
    'pptx-compat/require-table-cell-background': 'error',
    'pptx-compat/no-table-complex-content': 'error',
    'pptx-compat/require-image-border-radius': 'error',
    'pptx-compat/no-composite-border-on-text': 'error',
    'pptx-compat/no-line-height-centering': 'error',
    'pptx-compat/require-child-border-radius-in-rounded-container': 'error',
    'pptx-compat/no-shrinkwrap-absolute': 'error',
    'pptx-compat/no-decorative-bar-element': 'error',
    'pptx-compat/require-absolute-last': 'error',
    'pptx-compat/no-css-filter': 'error',
    'pptx-compat/no-overflow-hidden-with-bg-children': 'error',
    'pptx-compat/no-directive-on-br': 'error',
  },
};

export default plugin;
