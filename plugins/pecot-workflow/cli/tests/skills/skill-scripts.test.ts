/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
// スキルの scripts/ にあるスクリプトを、一時ディレクトリで実際に動かして結果を確かめる。
// あわせて、スキルの本文がスクリプトを埋め込まず、在るファイルを指していることを確かめる。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { attachOutput, attachText, readOutput } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { pluginRoot, readDocuments, readPluginFile } from './_helpers/documents.js'
import { explains } from '../_helpers/explains.js'

function scriptPath(relative: string): string {
  return path.join(pluginRoot, relative)
}

function runScript(relative: string, cwd: string) {
  const result = spawnSync(process.execPath, [scriptPath(relative)], { cwd, encoding: 'utf8' })
  attachOutput(`node ${relative}`, result.status ?? undefined, result.stdout, result.stderr)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('スキルの本文とスクリプトのファイル', () => {
  it.for([
    { skill: 'skills/w-onboarding/SKILL.md', script: 'scripts/detect-sibling-config.cjs' },
    { skill: 'skills/w-onboarding/SKILL.md', script: 'scripts/board-url.cjs' },
    { skill: 'skills/w-pr/SKILL.md', script: 'scripts/serve-preview.cjs' },
    { skill: 'skills/w-pr/SKILL.md', script: 'scripts/wait-pr.cjs' },
  ])('$skill は、base directory の $script を node で実行するよう書き、そのファイルが存在する', async ({ skill, script }) => {
    await explains(`スキルの本文とスクリプトの対応のテストです。\`${skill}\` に \`node <このスキルの base directory>/${script}\` の記述があり、そのスクリプトのファイルが存在することを確認します。`)
    expect(readPluginFile(skill)).toContain(`node <このスキルの base directory>/${script}`)
    const file = path.join(pluginRoot, path.dirname(skill), script)
    expect(existsSync(file)).toBe(true)
  })

  it('スキルとエージェントの本文に、node で実行するスクリプトを埋め込まない', async () => {
    await explains('スキルとエージェントの本文のテストです。`node --eval` や `node -p` などで、スクリプトを本文に直接書いた記述が含まれないことを確認します。')
    const embedded = readDocuments()
      .filter(({ text }) => /node (?:--input-type|--eval|-[ep] |- <<)/u.test(text))
      .map(({ file }) => file)
    expect(embedded).toStrictEqual([])
  })
})

function repositoryWith(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory()
  writeTree(directory, files)
  return directory
}

describe('w-onboarding Step 4 のボード URL の取得', () => {
  const script = 'skills/w-onboarding/scripts/board-url.cjs'
  const url = 'https://github.com/orgs/pecotcraft/projects/1'

  it('相対パスの .active から、ボード URL を 1 行で出力する', async () => {
    await explains('`board-url.cjs` のテストです。`.active` に相対パスが書かれている場合に、設定ファイルの `board_url` を 1 行で標準出力に出力し、終了コード 0 で終了することを確認します。')
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }),
    })
    expect(runScript(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('絶対パスの .active でも、ボード URL を 1 行で出力する', async () => {
    await explains('`board-url.cjs` のテストです。`.active` に絶対パスが書かれている場合でも、設定ファイルの `board_url` を 1 行で出力し、終了コード 0 で終了することを確認します。')
    const directory = repositoryWith({ '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }) })
    writeTree(directory, { '.pecot/config/projects/.active': `${path.join(directory, '.pecot/config/projects/p.json')}\n` })
    expect(runScript(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('board_url が存在しないと、終了コード 1 で止まる', async () => {
    await explains('`board-url.cjs` のテストです。設定ファイルに `board_url` が存在しない場合は、何も出力せず、終了コード 1 で終了することを確認します。')
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: {} }),
    })
    const result = runScript(script, directory)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('.active が存在しないと、終了コード 1 で止まる', async () => {
    await explains('`board-url.cjs` のテストです。`.active` のファイルが存在しない場合に、何も出力せず、終了コード 1 で終了することを確認します。')
    const result = runScript(script, repositoryWith({}))
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})

function git(cwd: string, ...arguments_: readonly string[]): void {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

// 親ディレクトリの下に、origin を持つ cur と、設定を持つ兄弟を置く。
function layout(origin: string, siblings: Readonly<Record<string, string>>): { parent: string, current: string } {
  const parent = makeTemporaryDirectory()
  const current = path.join(parent, 'cur')
  mkdirSync(current)
  git(current, 'init', '-q')
  git(current, 'remote', 'add', 'origin', origin)
  for (const [name, content] of Object.entries(siblings)) {
    writeTree(parent, { [`${name}/.pecot/config/projects/p.json`]: content })
  }
  return { parent, current }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

async function waitUntilServing(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/`)
      return
    }
    catch {
      await sleep(100)
    }
  }
  throw new Error('配信が立ちませんでした')
}

describe('w-onboarding の兄弟リポの検出', () => {
  const script = 'skills/w-onboarding/scripts/detect-sibling-config.cjs'

  const mine = JSON.stringify({ host: 'github.com', owner: 'pecotcraft' })
  const other = JSON.stringify({ host: 'github.com', owner: 'other' })
  const https = 'https://github.com/pecotcraft/cur.git'

  it('一致する設定ファイルが 1 件だと、MATCH の行でそのパスを出力する', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。同じ owner の設定ファイルを持つ兄弟のリポジトリが 1 件だけの場合に、`MATCH: ` に続けてそのパスを出力することを確認します。')
    const { current } = layout(https, { a: mine, b: other })
    expect(runScript(script, current)).toMatchObject({
      status: 0,
      stdout: 'MATCH: ../a/.pecot/config/projects/p.json\n',
    })
  })

  it('一致する設定ファイルが 2 件だと、複数見つかった旨と 2 行のパスを出力する', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。同じ owner の設定ファイルを持つ兄弟のリポジトリが 2 件の場合に、複数見つかった旨のメッセージと、2 行のパスを出力することを確認します。')
    const { current } = layout(https, { a: mine, b: mine })
    expect(runScript(script, current).stdout).toBe(
      '複数見つかりました（AskUserQuestion で選択）:\n'
      + '  ../a/.pecot/config/projects/p.json\n'
      + '  ../b/.pecot/config/projects/p.json\n',
    )
  })

  it('一致する設定ファイルが存在しないと、見つからなかった旨を出力する', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。同じ owner の設定ファイルを持つ兄弟のリポジトリが存在しない場合に、見つからなかった旨のメッセージを出力し、終了コード 0 で終了することを確認します。')
    const { current } = layout(https, { b: other })
    expect(runScript(script, current)).toMatchObject({
      status: 0,
      stdout: '兄弟リポに一致する設定ファイルが見つかりませんでした\n',
    })
  })

  it('ssh 形式の origin でも、一致する設定ファイルを 1 件と数える', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。`origin` が `git@github.com:pecotcraft/cur.git` の形でも、同じ owner の兄弟のリポジトリを 1 件検出することを確認します。')
    const { current } = layout('git@github.com:pecotcraft/cur.git', { a: mine })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it.for([
    'user@github.com:pecotcraft/cur.git',
    'ssh://git@github.com/pecotcraft/cur.git',
    'https://user:tok@github.com:8443/pecotcraft/cur.git',
    'git://github.com/pecotcraft/cur.git',
    'https://github.com/pecotcraft/cur/',
  ])('origin が %s でも、一致する設定ファイルを 1 件と数える', async (origin) => {
    await explains(`\`detect-sibling-config.cjs\` の \`origin\` の形式のテストです。\`origin\` が \`${origin}\` の場合でも、同じ owner の兄弟のリポジトリを 1 件検出することを確認します。`)
    const { current } = layout(origin, { a: mine })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it('別名の origin では、host が別名になり、一致する設定ファイルが存在しなくなる', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。`origin` が `gh-alias:pecotcraft/cur.git` の別名の場合に、host が別名として扱われ、見つからなかった旨を出力することを確認します。')
    const { current } = layout('gh-alias:pecotcraft/cur.git', { a: mine })
    expect(runScript(script, current).stdout).toBe('兄弟リポに一致する設定ファイルが見つかりませんでした\n')
  })

  it('シンボリックリンクの兄弟リポジトリも、一致する設定ファイルとして数える', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。兄弟のディレクトリがシンボリックリンクの場合でも、そのリンク先の設定ファイルを検出することを確認します。')
    const { parent, current } = layout(https, {})
    const outer = makeTemporaryDirectory()
    writeTree(outer, { '.pecot/config/projects/p.json': mine })
    symlinkSync(outer, path.join(parent, 'lnk'))
    expect(runScript(script, current).stdout).toBe('MATCH: ../lnk/.pecot/config/projects/p.json\n')
  })

  it('解析できない JSON は、一致する設定ファイルの数に入れない', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。JSON として解析できない設定ファイルが兄弟にあっても、一致の件数に入れず、正しい設定ファイルだけを検出することを確認します。')
    const { current } = layout(https, { a: mine, broken: '{"host":' })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it.for(['foo', 'git@github.com:~pecotcraft/cur.git', 'C:/pecotcraft/cur.git'])('origin が %s だと、解析できない旨の ERROR の行を出力して終了コード 1 で止まる', async (origin) => {
    await explains(`\`detect-sibling-config.cjs\` のテストです。\`origin\` が \`${origin}\` のように解析できない形式の場合に、\`ERROR: origin URL を解析できませんでした\` を出力し、終了コード 1 で終了することを確認します。`)
    const { current } = layout(origin, { a: mine })
    expect(runScript(script, current)).toMatchObject({
      status: 1,
      stdout: `ERROR: origin URL を解析できませんでした: ${origin}\n`,
    })
  })

  it('origin が存在しないと、取得できない旨の ERROR の行を出力して終了コード 1 で止まる', async () => {
    await explains('`detect-sibling-config.cjs` のテストです。リポジトリに `origin` が存在しない場合は、`ERROR: origin URL を取得できませんでした` を出力し、終了コード 1 で終了することを確認します。')
    const current = makeTemporaryDirectory()
    git(current, 'init', '-q')
    expect(runScript(script, current)).toMatchObject({
      status: 1,
      stdout: 'ERROR: origin URL を取得できませんでした\n',
    })
  })
})

// 状態・型・本文を、判定の前に添付する。
async function get(port: number, requestPath: string): Promise<{ status: number, contentType: string | null, body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${requestPath}`)
  const body = await response.text()
  const contentType = response.headers.get('content-type')
  attachText(`GET ${requestPath} の応答`, `${String(response.status)}\ncontent-type: ${contentType ?? ''}\n\n${body}`, '.txt')
  return { status: response.status, contentType, body }
}

describe('w-pr のプレビューの配信', () => {
  const script = scriptPath('skills/w-pr/scripts/serve-preview.cjs')
  let server: ChildProcess | undefined

  afterEach(() => {
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid)
      }
      catch {
        // すでに止まっている
      }
    }
    server = undefined
  })

  async function serve(): Promise<number> {
    const repository = makeTemporaryDirectory()
    writeTree(repository, { '.pecot/work/399/index.html': '<!doctype html><p>日本語</p>\n', 'secret.txt': 'x' })
    const port = await freePort()
    server = spawn(process.execPath, [script, '.pecot/work/399', String(port)], { cwd: repository, detached: true, stdio: 'ignore' })
    await waitUntilServing(port)
    return port
  }

  it('.html のファイルには、text/html の Content-Type で 200 を返す', async () => {
    await explains('`serve-preview.cjs` のテストです。`.html` のファイルを要求すると、ステータス 200 と `text/html` の Content-Type で、日本語の本文を返すことを確認します。')
    const port = await serve()
    const response = await get(port, '/index.html')
    expect(response.status).toBe(200)
    expect(response.contentType).toContain('text/html')
    expect(response.body).toContain('日本語')
  })

  it('..%2f で配信の起点の外を指定すると、403 を返す', async () => {
    await explains('`serve-preview.cjs` のテストです。`..%2f` を使って配信するディレクトリの外のファイルを要求すると、ステータス 403 を返すことを確認します。')
    const port = await serve()
    const response = await get(port, '/..%2f..%2f..%2fsecret.txt')
    expect(response.status).toBe(403)
  })

  it('存在しないパスには、404 を返す', async () => {
    await explains('`serve-preview.cjs` のテストです。存在しないパスを要求すると、ステータス 404 を返すことを確認します。')
    const port = await serve()
    const response = await get(port, '/nope.html')
    expect(response.status).toBe(404)
  })

  it('配信を止めると、接続を受け付けなくなる', async () => {
    await explains('`serve-preview.cjs` のテストです。起動したプロセスを止めた後に同じポートへ接続すると、接続に失敗することを確認します。')
    const port = await serve()
    if (server?.pid !== undefined) process.kill(-server.pid)
    await sleep(300)
    await expect(fetch(`http://127.0.0.1:${String(port)}/index.html`)).rejects.toThrow()
  })

  it.for(['70000', '-1', 'abc'])('port が %s だと、配信を立てられない旨を出力して終了コード 1 で止まる', async (port) => {
    await explains(`\`serve-preview.cjs\` のポートの検証のテストです。ポートに \`${port}\` を指定すると、0〜65535 の整数ではない旨を標準エラーに出力し、終了コード 1 で終了することを確認します。`)
    const repository = makeTemporaryDirectory()
    writeTree(repository, { '.pecot/work/399/index.html': '<p>x</p>\n' })
    const result = spawnSync(process.execPath, [script, '.pecot/work/399', port], { cwd: repository, encoding: 'utf8' })
    attachOutput(`node serve-preview.cjs .pecot/work/399 ${port}`, result.status ?? undefined, result.stdout, result.stderr)
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`配信を立てられません: port が 0〜65535 の整数ではありません（${port}）\n`)
  })
})

function open(mergeable: string, isInMergeQueue = false, checks?: string) {
  const commit = checks === undefined ? {} : { statusCheckRollup: { state: checks } }
  return { state: 'OPEN', mergeable, isInMergeQueue, commits: { nodes: [{ commit }] } }
}

function parseArguments(line: string): readonly string[] {
  const parsed: unknown = JSON.parse(line)
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
}

describe('w-pr の CI とマージの待ち受け', () => {
  const script = scriptPath('skills/w-pr/scripts/wait-pr.cjs')
  const url = 'https://github.com/pecotcraft/pecot-sandbox/pull/12'
  const fakeGh = readFileSync(path.join(import.meta.dirname, 'fixtures/fake-gh.mjs'), 'utf8')
  const merged = { state: 'MERGED', mergeable: 'UNKNOWN', isInMergeQueue: false }

  function waitPr(responses: readonly unknown[], arguments_: readonly string[] = ['merge', url, '0.05', '2']) {
    const bin = makeTemporaryDirectory()
    writeTree(bin, { 'gh': `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-gh.mjs" "$@"\n`, 'fake-gh.mjs': fakeGh, 'responses.json': JSON.stringify(responses) })
    chmodSync(path.join(bin, 'gh'), 0o755)
    const result = spawnSync(process.execPath, [script, ...arguments_], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
    })
    attachOutput(`node wait-pr.cjs ${arguments_.join(' ')}`, result.status ?? undefined, result.stdout, result.stderr)
    const log = path.join(bin, 'calls.log')
    const calls = existsSync(log) ? readOutput(log).trim().split('\n').map(line => parseArguments(line)) : []
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
  }

  it.for([
    { name: 'マージされた', responses: [merged], word: 'MERGED' },
    { name: 'マージされずに閉じられた', responses: [{ state: 'CLOSED', mergeable: 'MERGEABLE', isInMergeQueue: false }], word: 'CLOSED' },
    { name: 'base とコンフリクトした', responses: [open('CONFLICTING')], word: 'CONFLICTING' },
    { name: 'merge queue から外れて開いたまま', responses: [open('MERGEABLE', true), open('MERGEABLE')], word: 'DEQUEUED' },
    { name: 'CI が通った後で失敗した', responses: [open('MERGEABLE', false, 'SUCCESS'), open('MERGEABLE', false, 'FAILURE')], word: 'CI_FAILED' },
  ])('merge の待ちで、PR が $name なら、$word を 1 行出力して終了コード 0 で終了する', async ({ name, responses, word }) => {
    await explains(`\`wait-pr.cjs\` の merge の待ちのテストです。PR が「${name}」の状態の場合は、\`${word}\` を 1 行出力し、標準エラーには何も出力せず、終了コード 0 で終了することを確認します。`)
    expect(waitPr(responses)).toMatchObject({ status: 0, stdout: `${word}\n`, stderr: '' })
  })

  it.for([
    { name: 'CI が通った', responses: [open('MERGEABLE', false, 'PENDING'), open('MERGEABLE', false, 'SUCCESS')], word: 'CI_PASSED' },
    { name: 'CI が落ちた', responses: [open('MERGEABLE', false, 'PENDING'), open('MERGEABLE', false, 'FAILURE')], word: 'CI_FAILED' },
    { name: 'CI がエラーで終わった', responses: [open('MERGEABLE', false, 'ERROR')], word: 'CI_FAILED' },
    { name: 'CI の実行中に base とコンフリクトした', responses: [open('MERGEABLE', false, 'PENDING'), open('CONFLICTING', false, 'PENDING')], word: 'CONFLICTING' },
    { name: 'コンフリクトと CI の失敗が同時に起きた', responses: [open('CONFLICTING', false, 'FAILURE')], word: 'CONFLICTING' },
    { name: 'CI の結果より先にマージされた', responses: [open('MERGEABLE', false, 'PENDING'), merged], word: 'MERGED' },
    { name: '3 回続けて CI が 1 つも無い', responses: [open('MERGEABLE')], word: 'NO_CHECKS' },
  ])('ci の待ちで、$name なら、$word を 1 行出力して終了コード 0 で終了する', async ({ name, responses, word }) => {
    await explains(`\`wait-pr.cjs\` の ci の待ちのテストです。「${name}」場合は、\`${word}\` を 1 行出力し、標準エラーには何も出力せず、終了コード 0 で終了することを確認します。`)
    expect(waitPr(responses, ['ci', url, '0.05', '2'])).toMatchObject({ status: 0, stdout: `${word}\n`, stderr: '' })
  })

  it('ci の待ちで、CI の無い回が続いても、途中で CI が現れたら数え直す', async () => {
    await explains('`wait-pr.cjs` の ci の待ちのテストです。CI の無い回が 2 回続いた後に CI が現れると、CI の無い回を数え直し、`NO_CHECKS` を出さずに CI の結果を待つことを確認します。')
    const result = waitPr([open('MERGEABLE'), open('MERGEABLE'), open('MERGEABLE', false, 'PENDING'), open('MERGEABLE'), open('MERGEABLE', false, 'SUCCESS')], ['ci', url, '0.05', '2'])
    expect(result).toMatchObject({ status: 0, stdout: 'CI_PASSED\n' })
    expect(result.calls).toHaveLength(5)
  })

  it('ci の待ちで、必須の check の結果がまだ無い間は待ち続け、CI が通ったら CI_PASSED を出力する', async () => {
    await explains('`wait-pr.cjs` の ci の待ちのテストです。CI の状態が `EXPECTED` の回では何も出力せず、次の回の状態が `SUCCESS` の場合は `CI_PASSED` を出力することを確認します。')
    const result = waitPr([open('MERGEABLE', false, 'EXPECTED'), open('MERGEABLE', false, 'SUCCESS')], ['ci', url, '0.05', '2'])
    expect(result).toMatchObject({ status: 0, stdout: 'CI_PASSED\n' })
    expect(result.calls).toHaveLength(2)
  })

  it('merge の待ちでは、CI が通っても、CI が無くても抜けずに待ち続ける', async () => {
    await explains('`wait-pr.cjs` の merge の待ちのテストです。CI が通った回や CI の無い回では何も出力せず、マージされた時点で `MERGED` を出力することを確認します。')
    const result = waitPr([open('MERGEABLE'), open('MERGEABLE'), open('MERGEABLE'), open('MERGEABLE', false, 'SUCCESS'), merged])
    expect(result).toMatchObject({ status: 0, stdout: 'MERGED\n' })
    expect(result.calls).toHaveLength(5)
  })

  it('PR が開いたまま待ち時間の上限に達すると、TIMEOUT を出力して終了コード 0 で終了する', async () => {
    await explains('`wait-pr.cjs` のテストです。PR が開いたまま待ち時間の上限に達した場合は、`TIMEOUT` を出力し、終了コード 0 で終了することを確認します。')
    const result = waitPr([open('MERGEABLE', false, 'PENDING')], ['ci', url, '0.05', '0.3'])
    expect(result).toMatchObject({ status: 0, stdout: 'TIMEOUT\n' })
    expect(result.calls.length).toBeGreaterThan(1)
  })

  it('PR の URL のホスト・owner・repo・番号を指定して、GraphQL で状態と CI の結果を取得する', async () => {
    await explains('`wait-pr.cjs` の `gh` の呼び出しのテストです。PR の URL から求めたホスト・owner・repo・番号を指定して、`isInMergeQueue` と `statusCheckRollup` を含む GraphQL のクエリを呼ぶことを確認します。')
    const [call] = waitPr([merged]).calls
    expect(call?.slice(0, 4)).toStrictEqual(['api', '--hostname', 'github.com', 'graphql'])
    expect(call).toEqual(expect.arrayContaining(['owner=pecotcraft', 'repo=pecot-sandbox', 'number=12']))
    const query = call?.find(argument => argument.startsWith('query='))
    expect(query).toContain('isInMergeQueue')
    expect(query).toContain('statusCheckRollup')
  })

  it('gh が 1 回失敗しても、状態を取得し直して続ける', async () => {
    await explains('`wait-pr.cjs` のテストです。`gh` の呼び出しが 1 回失敗しても、取得し直して続け、マージされた場合に `MERGED` を出力することを確認します。')
    expect(waitPr(['fail', merged])).toMatchObject({ status: 0, stdout: 'MERGED\n' })
  })

  it('gh が 3 回続けて失敗すると、理由を標準エラーに出力して終了コード 1 で止まる', async () => {
    await explains('`wait-pr.cjs` のテストです。`gh` の呼び出しが 3 回続けて失敗した場合に、失敗の理由を標準エラーに出力し、終了コード 1 で終了することを確認します。')
    const result = waitPr(['fail'])
    expect(result).toMatchObject({ status: 1, stdout: '', stderr: '待ち受けを続けられません: HTTP 502\n' })
    expect(result.calls).toHaveLength(3)
  })

  it.for([
    { name: '待ち方が無い', arguments_: [], message: '待ち方が ci でも merge でもありません（）' },
    { name: '待ち方の代わりに URL', arguments_: [url], message: `待ち方が ci でも merge でもありません（${url}）` },
    { name: '間隔が 0', arguments_: ['merge', url, '0'], message: '間隔が正の数ではありません（0）' },
    { name: '上限が数でない', arguments_: ['ci', url, '1', 'abc'], message: '上限が正の数ではありません（abc）' },
    { name: 'URL が PR を指さない', arguments_: ['merge', 'https://github.com/pecotcraft/pecot-sandbox/issues/12'], message: 'PR の URL ではありません（https://github.com/pecotcraft/pecot-sandbox/issues/12）' },
  ])('$name だと、gh を呼ばずに終了コード 1 で止まる', async ({ name, arguments_, message }) => {
    await explains(`\`wait-pr.cjs\` の引数の検証のテストです。「${name}」の場合に、\`gh\` を呼ばず、「${message}」を標準エラーに出力して、終了コード 1 で終了することを確認します。`)
    expect(waitPr([open('MERGEABLE')], arguments_)).toMatchObject({ status: 1, stdout: '', stderr: `待ち受けを続けられません: ${message}\n`, calls: [] })
  })
})
