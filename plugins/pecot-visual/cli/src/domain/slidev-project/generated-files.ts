// talk-dir に本体が生成する `vite.config.ts` と `start.mjs` の中身。
//
// テンプレートからはコピーしない。中身は本体の版とテーマの名前だけで決まる。
// create が書き、移行前の sync がコピーの後に書く。
// 移行済みの talk-dir では、dev・convert・sync の張り直しが、今の内容と違えば書き直す。
// テーマの peerDependencies は、生成した設定が読み込み時に求める。テーマの版を上げても内容は変わらない。

export interface ViteConfigOptions {
  /**
  talk-dir の `node_modules` に張るテーマのパッケージ名。
  渡すと、そのテーマの `public/` を `/theme/` で配る設定を書く。
  省略すると書かない。
  */
  readonly themeName?: string
}

function quoted(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

/**
テーマの `public/` を `/theme/` へ配る設定と、テーマの warmup の行。
テーマの `peerDependencies` を求めて `themePeers` に置く行も含む（`resolve.dedupe` に渡す）。

Slidev 53 は、テーマの `public/` の絶対パスと `*` を vite-plugin-static-copy へ渡す。
そのままでは、出力先にテーマまでのパスが残り、`public/assets/` の下のファイルも拾われない。
そこで `slidev.staticCopy.targets` で上書きする。
パスは設定の読み込み時に talk-dir から求めるので、talk-dir を別の端末へ移しても動く。

`stripBase` は、talk-dir からテーマの `public/` までの区間の数。
vite-plugin-static-copy は、talk-dir からの相対パスの先頭の `../` だけを外して出力先に残す。
その残りを、この数だけ削る。
*/
function themePublicLines(themeName: string): string[] {
  return [
    '',
    '// location of the talk-dir, next to this config file.',
    'const talkDirectory = path.dirname(fileURLToPath(import.meta.url))',
    '',
    '// resolve the real path; return undefined when it is missing and leave it to the Slidev default.',
    'function resolveRealPath(...segments: string[]): string | undefined {',
    '  try {',
    '    return realpathSync(path.join(...segments))',
    '  }',
    '  catch {',
    '    return undefined',
    '  }',
    '}',
    '',
    '// make glob special characters match literally; normalize the Windows separator to /.',
    'function escapeGlob(value: string): string {',
    '  const posixPath = path.sep === \'\\\\\' ? value.replaceAll(\'\\\\\', \'/\') : value',
    '  const specials = path.sep === \'\\\\\' ? /[()[\\]{}!+@]/gu : /[\\\\()[\\]{}!*?|+@]/gu',
    '  return posixPath.replaceAll(specials, \'\\\\$&\')',
    '}',
    '',
    '// real path of the theme and its public/.',
    `const themeRoot = resolveRealPath(talkDirectory, 'node_modules', ${quoted(themeName)})`,
    'const themePublic = themeRoot === undefined ? undefined : resolveRealPath(themeRoot, \'public\')',
    '',
    '// names in the theme peerDependencies that resolve from node_modules of the talk-dir.',
    '// optional ones are excluded; Vite resolves dedupe names from the root only and fails to start when one is not found.',
    '// return an empty list when the file is unreadable or not JSON, so loading the config does not stop.',
    'function readThemePeers(): string[] {',
    '  if (themeRoot === undefined) return []',
    '  try {',
    '    const manifest = JSON.parse(readFileSync(path.join(themeRoot, \'package.json\'), \'utf8\')) as {',
    '      peerDependencies?: Record<string, string>',
    '      peerDependenciesMeta?: Record<string, { optional?: boolean }>',
    '    }',
    '    const optional = manifest.peerDependenciesMeta ?? {}',
    '    return Object.keys(manifest.peerDependencies ?? {}).filter(name =>',
    '      optional[name]?.optional !== true && resolveRealPath(talkDirectory, \'node_modules\', name) !== undefined)',
    '  }',
    '  catch {',
    '    return []',
    '  }',
    '}',
    '',
    'const themePeers = readThemePeers()',
    '',
    '// number of segments from the talk-dir to the theme public/ (leading ../ are not counted).',
    'const themePublicDepth = themePublic === undefined',
    '  ? 0',
    '  : path.relative(talkDirectory, themePublic).split(/[\\\\/]/u).filter(segment => segment !== \'..\').length',
    '',
    'const themeStaticCopy = themePublic === undefined',
    '  ? {}',
    '  : {',
    '      staticCopy: {',
    '        targets: [',
    '          {',
    '            src: `${escapeGlob(themePublic)}/**/*`,',
    '            dest: \'theme\',',
    '            rename: { stripBase: themePublicDepth },',
    '          },',
    '        ],',
    '      },',
    '    }',
    '',
    '// transform theme layouts, components and styles in the warmup at dev start.',
    '// Vite ignores globs under node_modules, so write them with the real path of the theme.',
    '// files of the same name on the talk-dir side override the theme and belong to the user, so list them with relative globs.',
    'const themeServer = themeRoot === undefined',
    '  ? {}',
    '  : {',
    '      warmup: {',
    '        clientFiles: [',
    '          `${escapeGlob(themeRoot)}/layouts/**/*.vue`,',
    '          `${escapeGlob(themeRoot)}/components/**/*.vue`,',
    '          `${escapeGlob(themeRoot)}/styles/**/*.css`,',
    '          \'./layouts/**/*.vue\',',
    '          \'./components/**/*.vue\',',
    '          \'./styles/**/*.css\',',
    '        ],',
    '      },',
    '    }',
  ]
}

/**
`vite.config.ts` の中身。
中身は 1 行 1 要素の配列で組み立てる。
*/
export function viteConfigSource(options: Readonly<ViteConfigOptions>): string {
  const themeName = options.themeName
  const dedupeLine = themeName === undefined ? '    dedupe: [],' : '    dedupe: themePeers,'
  const themeLines = themeName === undefined ? [] : themePublicLines(themeName)
  const importLines = themeName === undefined
    ? []
    : [
        'import { readFileSync, realpathSync } from \'node:fs\'',
        'import path from \'node:path\'',
        'import { fileURLToPath } from \'node:url\'',
      ]
  const slidevLines = themeName === undefined
    ? []
    : [
        '  // serve the theme public/ at /theme/.',
        '  slidev: themeStaticCopy,',
      ]
  const serverSpread = themeName === undefined ? [] : ['    ...themeServer,']
  return [
    '// generated by pecotv; rewritten when pecotv is updated.',
    '// put extra Vite settings in setup/vite-plugins.ts.',
    '/// <reference types="@slidev/types" />',
    ...importLines,
    'import { defineConfig } from \'vite\'',
    ...themeLines,
    '',
    'export default defineConfig({',
    '  // keep the cache inside the talk-dir.',
    '  // sharing node_modules/.vite causes conflicts.',
    '  cacheDir: \'./.vite\',',
    '  resolve: {',
    '    // node_modules and the theme are linked with symlinks.',
    '    // with the Vite default (false), scoped CSS of Vue files behind a symlink is left out of the build.',
    '    preserveSymlinks: true,',
    '    // dedupe the theme peerDependencies to the single copy of the main package.',
    dedupeLine,
    '  },',
    ...slidevLines,
    '  server: {',
    ...serverSpread,
    '    // keep the browser from using stale transform results after the dev server restarts.',
    '    // with stale results, CSS outside the allow list is rejected with 403 and the preview stays blank.',
    '    headers: { \'Cache-Control\': \'no-cache\' },',
    '  },',
    '  define: {',
    '    // pecotv slide convert loads the print page once and converts all pages.',
    '    // this setting puts the print route into the built SPA.',
    '    // it is a Slidev-internal define, not a public API.',
    '    // when this flag has no effect on a build, pecotv warns and converts the old way.',
    '    __SLIDEV_FEATURE_PRINT__: \'true\',',
    '  },',
    '})',
  ].join('\n')
  + '\n'
}

/**
`start.mjs` の中身。
MCP を使わない環境で、手動でプレビューを起動するためのスクリプト。
*/
export const START_SCRIPT_SOURCE: string = [
  '#!/usr/bin/env node',
  '',
  '/**',
  ' * OS-independent Slidev start script (generated by pecotv).',
  ' *',
  ' * A way to preview manually in environments that do not use MCP.',
  ' * It targets editors and plain terminals that have not registered the pecot-visual server.',
  ' * The directory of this script is the working root.',
  ' * node_modules is prepared by pecotv slide create and pecotv slide sync.',
  ' * When it is missing, the script points to sync and exits.',
  ' * It starts the Slidev bin directly with node.',
  ' */',
  '',
  'import { fileURLToPath } from \'node:url\'',
  'import { dirname, join } from \'node:path\'',
  'import { spawn } from \'node:child_process\'',
  'import { existsSync } from \'node:fs\'',
  '',
  'const __filename = fileURLToPath(import.meta.url)',
  'const __dirname = dirname(__filename)',
  '',
  'const slidevBin = join(__dirname, \'node_modules\', \'@slidev\', \'cli\', \'bin\', \'slidev.mjs\')',
  '',
  'if (!existsSync(slidevBin)) {',
  '  console.error(\'error: @slidev/cli not found at \' + slidevBin + \'.\')',
  '  console.error(\'  run pecotv slide sync --dir \' + __dirname + \' --node-modules-only\')',
  '  process.exit(1)',
  '}',
  '',
  'const slidevArgs = [slidevBin, \'--remote\']',
  'const port = process.env.SLIDEV_PORT',
  'if (port) {',
  '  slidevArgs.push(\'--port\', port)',
  '}',
  '',
  'const slidev = spawn(process.execPath, slidevArgs, {',
  '  cwd: __dirname,',
  '  stdio: \'inherit\',',
  '})',
  '',
  'slidev.on(\'error\', (error) => {',
  '  console.error(\'error: Failed to start Slidev:\', error)',
  '  process.exit(1)',
  '})',
  '',
  'slidev.on(\'exit\', (code) => {',
  '  process.exit(code ?? 0)',
  '})',
].join('\n')
+ '\n'
