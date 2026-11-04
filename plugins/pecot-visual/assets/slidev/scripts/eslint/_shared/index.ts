export {
  loadLayoutReference,
  getClicksValidation,
  getLayoutProps,
  getLayoutPropTree,
  isPlainObject,
  clearCache,
  collectMatchingLengthDeclarations,
} from './lib/reference-loader.ts';
export type {
  ClicksValidationConfig,
  PropSchemaNode,
  MatchingLengthDeclaration,
} from './lib/reference-loader.ts';
export { parseFrontmatter, extractFrontmatterText } from './lib/frontmatter-parser.ts';
export type { FrontmatterBase } from './lib/frontmatter-parser.ts';
export { parseFieldPath, resolveFieldValues } from './lib/field-resolver.ts';
export type { FieldSegment, ResolvedField } from './lib/field-resolver.ts';
export {
  validateText,
  stripHtmlTags,
  isFullWidth,
  fullWidthEquivalent,
  hasBoldEmphasis,
  BOLD_REQUIRED_MESSAGE,
  hasDisallowedEmTag,
  EM_DISALLOWED_MESSAGE,
} from './lib/text-measurer.ts';
export type { TextConstraint, TextValidationError } from './lib/text-measurer.ts';
export { readThemeSettings, THEME_SETTINGS_KEY } from './lib/theme-settings.ts';
export type { ThemeLintSettings, SettingsContext } from './lib/theme-settings.ts';
export {
  VIEWER_BORDER,
  maxDiagramBounds,
  DrawioGeometryError,
  parseDrawio,
  resolveCellRect,
  fitDiagram,
  toPanelPoint,
  staticImageOrigin,
  cellCenterPercent,
} from './lib/drawio-geometry.ts';
export type * from './lib/drawio-geometry.ts';
