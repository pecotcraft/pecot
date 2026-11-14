// MCP ツール名の語彙。名前は `<対象>_<動詞>` の 2 語で、定義書の書き出しが names に写す。

/**
ツール名の語と、その意味
*/
export interface ToolNameWord {
  readonly word: string
  readonly meaning: string
}

export const TOOL_NAME_SEPARATOR = '_'

/**
ツール名の 1 語目。ツールが扱う対象
*/
export const TOOL_SUBJECTS: readonly ToolNameWord[] = [
  { word: 'drawio', meaning: 'draw.io diagrams' },
  { word: 'evidence', meaning: 'evidence workbooks built from screenshots' },
  { word: 'slide', meaning: 'Slidev decks and talk directories' },
  { word: 'runtime', meaning: 'runtime dependencies and Playwright Chromium' },
]

/**
ツール名の 2 語目。対象に対する操作
*/
export const TOOL_VERBS: readonly ToolNameWord[] = [
  { word: 'create', meaning: 'generate a new file or directory' },
  { word: 'export', meaning: 'write a diagram out as SVG and PDF' },
  { word: 'convert', meaning: 'convert a deck to PPTX' },
  { word: 'dev', meaning: 'start the dev server' },
  { word: 'lint', meaning: 'list rule violations in a talk directory' },
  { word: 'page', meaning: 'generate a page skeleton for a layout' },
  { word: 'sync', meaning: 'bring a talk directory in line with its theme' },
  { word: 'theme', meaning: 'return the theme declaration and its layouts' },
  { word: 'setup', meaning: 'download what other tools need at run time' },
]
