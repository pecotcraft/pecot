// 処理ごとに src/<処理>.ts の main を起点にし、actions/<処理>/dist/index.js に 1 つのファイルでまとめる。dist は commit する。
import { readdirSync } from 'node:fs'
import path from 'node:path'

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

import { actionEntry, entryId } from './scripts/action-entry.mjs'
import { rawText } from './scripts/raw-text.mjs'

const root = import.meta.dirname
const names = readdirSync(path.join(root, 'src'))
  .filter(file => file.endsWith('.ts') && file !== 'entry.ts')
  .map(file => file.slice(0, -'.ts'.length))

// 依存の package の中で起きる、動きに関わらない警告だけを外す
const QUIET = new Set(['THIS_IS_UNDEFINED', 'CIRCULAR_DEPENDENCY', 'INVALID_ANNOTATION'])

export default names.map(name => ({
  onwarn(warning, warn) {
    if (QUIET.has(warning.code ?? '') && (warning.id ?? warning.ids?.[0] ?? '').includes('node_modules')) return
    warn(warning)
  },
  input: entryId(path.join(root, 'src', `${name}.ts`)),
  output: { file: path.join(root, name, 'dist', 'index.js'), format: 'es', sourcemap: false },
  plugins: [
    actionEntry(),
    rawText(),
    typescript({ tsconfig: path.join(root, 'tsconfig.build.json') }),
    nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
    commonjs(),
    json(),
  ],
}))
