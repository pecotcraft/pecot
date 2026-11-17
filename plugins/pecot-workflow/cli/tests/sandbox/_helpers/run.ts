/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
// sandbox のスクリプトを、偽の gh を PATH に置いた一時ディレクトリで動かす補助。
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { installFakeExecutable } from '../../../src/tests/_helpers/fake-executables.js'
import { makeTemporaryDirectory } from '../../../src/tests/_helpers/temporary.js'
import { pluginRoot } from '../../skills/_helpers/documents.js'

export const repositoryRoot = path.resolve(pluginRoot, '../..')

export interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface Sandbox {
  readonly directory: string
  readonly bin: string
  readonly fake: string
}

/**
bash の本体を持つ偽の gh を置く。installFakeExecutable は sh で呼び出しを記録するので、本体は bash の標準入力へ渡す
*/
export function makeSandbox(ghScript: string): Sandbox {
  const directory = makeTemporaryDirectory()
  const bin = path.join(directory, 'bin')
  const fake = path.join(directory, 'fake')
  mkdirSync(bin)
  mkdirSync(fake)
  installFakeExecutable(bin, 'gh', `exec bash -s -- "$@" <<'FAKE_GH_BODY'\n${ghScript}\nFAKE_GH_BODY\n`)
  return { directory, bin, fake }
}

/**
process.env を書き換えず、PATH の先頭に偽の gh を置いて動かす。外の git の環境変数は引き継がない
*/
export function runScript(sandbox: Readonly<Sandbox>, script: string, argumentsList: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): Result {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  const environment = {
    ...Object.fromEntries(inherited),
    PATH: `${sandbox.bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
    FAKE_GH_DIR: sandbox.fake,
    ...extraEnvironment,
  }
  const result = spawnSync('bash', [script, ...argumentsList], { cwd: sandbox.directory, env: environment, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
フィクスチャのファイル名は、エンドポイントの記号以外を _ に替えたもの
*/
export function fixtureName(endpoint: string): string {
  return endpoint.replaceAll(/[^A-Za-z0-9]/gu, '_')
}

export function pluginScript(relative: string): string {
  return path.join(pluginRoot, relative)
}

const MAX_LINES = 100_000

/**
末尾の改行を落として行に分ける
*/
export function splitLines(text: string): string[] {
  return text.replace(/\n$/u, '').split('\n', MAX_LINES)
}
