// slide_theme ツール。talk-dir が参照するテーマの宣言とレイアウトの一覧を返す。

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  errorToReason,
  executeSlideTheme,
  slideThemeDefaultDependencies,
} from '../../commands/slidev-project/theme.js'
import type { SlideThemeDependencies } from '../../commands/slidev-project/theme.js'
import { failureKindOf } from '../../domain/_shared/failure-kind.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { ToolDefinition } from '../server.js'
import { formatError, PATH_REJECTION_OUTPUT_SHAPE, toolOutputFields, WINDOWS_PATH_NOTE, withPresence } from './_shared.js'
import { LAYOUT_CATALOG_OUTPUT_SHAPE } from './slide.js'

const slideThemeInput = z.object({
  dir: z.string()
    .describe('Absolute path of the talk-dir whose theme to inspect. Relative paths are not accepted. ' + WINDOWS_PATH_NOTE),
})

const sizeOutput = z.strictObject({ width: z.number(), height: z.number() })
const severityOutput = z.enum(['error', 'warn', 'off'])
const panelsOutput = z.record(z.string(), sizeOutput).describe('Panel size of the diagram per layout name')
const rulesOutput = z.record(z.string(), severityOutput).describe('Severity per lint rule ID')

const declarationFontsOutput = z.strictObject({
  body: z.array(z.string()),
  heading: z.array(z.string()),
  eastAsian: z.string().optional(),
})
const markerLayoutsOutput = z.array(z.string())

const slideThemeShape = {
  event: z.string().describe('slide.theme.done on success, slide.theme.error on failure (omitted when a path argument is rejected)'),
  theme: z.strictObject({
    name: z.string().describe('Package name of the theme'),
    spec: z.string().describe('Theme specification in the dependencies of package.json'),
    declared: z.boolean().describe('Whether the theme has pecot-theme.json'),
    directory: z.string().describe('Absolute path of the theme root'),
    linked: z.boolean().describe('Whether the theme was found in node_modules directly under the talk-dir'),
  }).describe('Theme the talk-dir references (success only)'),
  declaration: z.strictObject({
    schema: z.number(),
    slide: sizeOutput,
    fonts: declarationFontsOutput,
    fontSizes: z.strictObject({
      heading: z.number(),
      headingSm: z.number(),
      body: z.number(),
      bodySm: z.number(),
      label: z.number(),
    }),
    pptx: z.strictObject({ eastAsianFont: z.string().optional(), linkColor: z.string().optional() }),
    lint: z.strictObject({ rules: rulesOutput }),
    layouts: z.strictObject({ references: z.string() }),
    drawio: z.strictObject({ panels: panelsOutput, markerLayouts: markerLayoutsOutput }),
  }).describe('Theme declaration with omitted items filled with defaults (success only)'),
  ...withPresence(LAYOUT_CATALOG_OUTPUT_SHAPE, 'success only'),
  lint: z.strictObject({
    referencesDirectories: z.array(z.string()).describe('Directories searched for reference yaml, in priority order'),
    panels: panelsOutput,
    markerLayouts: markerLayoutsOutput.describe('Layout names that have marker cells'),
    rules: rulesOutput,
  }).describe('Input passed to the deck lint (success only)'),
}
const slideThemeOutput = toolOutputFields(slideThemeShape, PATH_REJECTION_OUTPUT_SHAPE)

/**
`theme`（名前・指定・宣言の有無・root）、`declaration`、`layouts`、`categories`、`lint`、`warnings` を返す。
*/
export function slideThemeTool(
  buildDependencies: () => SlideThemeDependencies = slideThemeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_theme',
    config: {
      title: 'Get Slidev theme',
      description: 'Returns the theme declaration referenced by a talk-dir and the list of layouts. '
        + 'The declaration covers fonts, font sizes, PPTX fonts and link colors, and lint rules. '
        + 'Skills use it to obtain theme values.',
      inputSchema: slideThemeInput,
      outputSchema: slideThemeOutput,
      // 読み取りのみで何も書き換えず、ネットワークにも到達しない。
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideThemeInput, arguments_, ['dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const { dir } = validated.input

      try {
        const { data } = await executeSlideTheme({ dir }, buildDependencies())
        return toCallToolResult({
          ok: true,
          data: { ...data },
          message: `slide_theme: ${data.theme.name} (${String(data.layouts.length)} layouts)`,
        })
      }
      catch (error: unknown) {
        return toCallToolResult({
          ok: false,
          kind: failureKindOf(errorToReason(error)),
          detail: formatError(error),
          data: { event: 'slide.theme.error' },
        })
      }
    },
  }
}
