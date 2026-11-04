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
    '// talk-dir の位置。設定ファイルの隣にある。',
    'const talkDirectory = path.dirname(fileURLToPath(import.meta.url))',
    '',
    '// 実体のパスを求める。無ければ undefined にして、Slidev の既定に任せる。',
    'function resolveRealPath(...segments: string[]): string | undefined {',
    '  try {',
    '    return realpathSync(path.join(...segments))',
    '  }',
    '  catch {',
    '    return undefined',
    '  }',
    '}',
    '',
    '// glob の特殊文字を、文字そのものとして扱わせる。Windows の区切りは / にそろえる。',
    'function escapeGlob(value: string): string {',
    '  const posixPath = path.sep === \'\\\\\' ? value.replaceAll(\'\\\\\', \'/\') : value',
    '  const specials = path.sep === \'\\\\\' ? /[()[\\]{}!+@]/gu : /[\\\\()[\\]{}!*?|+@]/gu',
    '  return posixPath.replaceAll(specials, \'\\\\$&\')',
    '}',
    '',
    '// テーマの実体と、その public/。',
    `const themeRoot = resolveRealPath(talkDirectory, 'node_modules', ${quoted(themeName)})`,
    'const themePublic = themeRoot === undefined ? undefined : resolveRealPath(themeRoot, \'public\')',
    '',
    '// テーマの peerDependencies のうち、talk-dir の node_modules から解決できる名前。',
    '// optional の名前は除く。Vite は dedupe の名前を root からだけ解決し、見つからないと起動が失敗する。',
    '// 読めない・JSON でないときは空にして、設定の読み込みを止めない。',
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
    '// talk-dir からテーマの public/ までの区間の数（先頭の ../ は数えない）。',
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
    '// テーマの layouts・components・styles は、dev の起動時の warmup で変換しておく。',
    '// node_modules の下の glob は、Vite が無視する。そのためテーマの実体のパスで書く。',
    '// talk-dir の側の同名のファイルは、テーマを上書きする利用者のものなので、相対の glob で並べる。',
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
日本語を含む行は、文章 lint が 1 行ずつ読む。そのため、中身は 1 行 1 要素の配列で組み立てる。
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
        '  // テーマの public/ を /theme/ で配る。',
        '  slidev: themeStaticCopy,',
      ]
  const serverSpread = themeName === undefined ? [] : ['    ...themeServer,']
  return [
    '// 本体が生成するファイル。本体の更新で書き直す。',
    '// Vite の追加設定は setup/vite-plugins.ts に置く。',
    '/// <reference types="@slidev/types" />',
    ...importLines,
    'import { defineConfig } from \'vite\'',
    ...themeLines,
    '',
    'export default defineConfig({',
    '  // キャッシュを talk-dir に閉じる。',
    '  // node_modules/.vite を共有すると衝突する。',
    '  cacheDir: \'./.vite\',',
    '  resolve: {',
    '    // node_modules とテーマは symlink で張る。',
    '    // Vite の既定（false）では、symlink 先の Vue ファイルの scoped CSS が build に入らない。',
    '    preserveSymlinks: true,',
    '    // テーマの peerDependencies は、本体の 1 つに寄せる。',
    dedupeLine,
    '  },',
    ...slidevLines,
    '  server: {',
    ...serverSpread,
    '    // dev サーバを起動し直した後も、ブラウザに古い変換結果を使わせない。',
    '    // 古い結果を使うと、許可リストの外の CSS が 403 で拒まれ、プレビューが白紙のままになる。',
    '    headers: { \'Cache-Control\': \'no-cache\' },',
    '  },',
    '  define: {',
    '    // pecotv の slide convert は print ページを 1 回読み込んで全ページを変換する。',
    '    // その print ルートを build 済み SPA に入れるための指定。',
    '    // Slidev 内部の define であり、公開 API ではない。',
    '    // このフラグが働かない build では、pecotv が警告を出して従来方式で変換する。',
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
  ' * OS 非依存の Slidev 起動スクリプト（pecotv が生成する）。',
  ' *',
  ' * MCP を使わない環境向けの、手動プレビューの手段。',
  ' * 対象は、pecot-visual サーバを登録していないエディタや素の端末。',
  ' * このスクリプトのあるディレクトリを動作起点とする。',
  ' * node_modules は pecotv slide create と pecotv slide sync が用意する。',
  ' * 無ければ sync を案内して終了する。',
  ' * Slidev の bin を、node で直接起動する。',
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
  '  console.error(\'@slidev/cli not found at \' + slidevBin + \'.\')',
  '  console.error(\'pecotv slide sync --dir \' + __dirname + \' --node-modules-only を実行してください。\')',
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
  '  console.error(\'Failed to start Slidev:\', error)',
  '  process.exit(1)',
  '})',
  '',
  'slidev.on(\'exit\', (code) => {',
  '  process.exit(code ?? 0)',
  '})',
].join('\n')
+ '\n'
