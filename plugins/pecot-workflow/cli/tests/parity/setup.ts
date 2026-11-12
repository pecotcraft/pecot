/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// シナリオの setup から、一時 root と子プロセスの環境変数を組み立てる。
//
// 一時 root の中身は次のとおり。
//   base/<repo>/                 作業リポ。origin は git@<host>:<owner>/<repo>.git の形にする。
//   remotes/<owner>/<repo>.git   origin の実体（bare）。
//   stub/gh, stub/fake-ssh       PATH の先頭に置く偽物。fake-ssh は origin を bare につなぐ。
//   data/                        データ置き場（CLAUDE_PLUGIN_DATA）。
//   home/, tmp/                  HOME と TMPDIR。
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { FileSpec, Scenario } from './scenario.js'

export const pluginRoot = realpathSync(path.resolve(import.meta.dirname, '../../..'))

export interface Sandbox {
  readonly root: string
  readonly repositoryDirectory: string
  readonly dataDirectory: string
  readonly stubDir: string
}

// 日時は固定する。実行のたびにコミットの SHA が変わらないようにするため。
const GIT_DATE = '2026-01-01T00:00:00+0000'

// 作業リポの .git/info/exclude の中身。出力に入りうるので固定する。
const GIT_EXCLUDE = '# parity fixed exclude\n'

const GIT_CONFIG = `[init]
\tdefaultBranch = main
[advice]
\tdetachedHead = false
\tstatusHints = false
\tpushUpdateRejected = false
\tpushNonFastForward = false
\tfetchShowForcedUpdates = false
\taddIgnoredFile = false
\tresolveConflict = false
\twaitingForEditor = false
[commit]
\tgpgsign = false
[core]
\tautocrlf = false
`

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', String.raw`'\''`)}'`
}

export function writeFiles(baseDirectory: string, files: Readonly<Record<string, FileSpec>>): void {
  for (const [relative, spec] of Object.entries(files)) {
    const target = path.join(baseDirectory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    if (typeof spec === 'string') writeFileSync(target, spec)
    else symlinkSync(spec.symlink, target)
  }
}

/**
子プロセスに渡す env のうち、接続先に依らない部分
*/
export function baseEnvironment(sandbox: Sandbox): Record<string, string> {
  return {
    PATH: `${sandbox.stubDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: path.join(sandbox.root, 'home'),
    TMPDIR: path.join(sandbox.root, 'tmp'),
    CLAUDE_PROJECT_DIR: sandbox.repositoryDirectory,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: sandbox.dataDirectory,
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    COLUMNS: '80',
    NO_COLOR: '1',
    TERM: 'dumb',
    // 一時 root がリポジトリの中にあっても、親をたどって実リポを読まない
    GIT_CEILING_DIRECTORIES: sandbox.root,
    GIT_CONFIG_GLOBAL: path.join(sandbox.root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Parity Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_NAME: 'Parity Author',
    GIT_COMMITTER_EMAIL: 'author@example.com',
    GIT_COMMITTER_DATE: GIT_DATE,
    // GIT_SSH_COMMAND はシェルを通り、空白を含むパスで失敗する。GIT_SSH は実行ファイルとして直接起動される
    GIT_SSH: path.join(sandbox.stubDir, 'fake-ssh'),
    GIT_SSH_VARIANT: 'simple',
    DEVCONTAINER: '1',
    // 外へ出さない。127.0.0.1 と localhost だけをプロキシの対象から外す
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    NODE_USE_ENV_PROXY: '1',
  }
}

function git(sandbox: Sandbox, cwd: string, arguments_: readonly string[]): void {
  execFileSync('git', arguments_, { cwd, env: baseEnvironment(sandbox), stdio: 'pipe' })
}

function commitAll(sandbox: Sandbox, message: string): void {
  git(sandbox, sandbox.repositoryDirectory, ['add', '-A'])
  git(sandbox, sandbox.repositoryDirectory, ['commit', '-q', '-m', message])
}

export function createSandbox(scenario: Scenario): Sandbox {
  const created = mkdtempSync(path.join(tmpdir(), 'pecot-parity-'))
  try {
    return populateSandbox(scenario, realpathSync(created))
  }
  catch (error) {
    rmSync(created, { recursive: true, force: true })
    throw error
  }
}

function populateSandbox(scenario: Scenario, root: string): Sandbox {
  const { repo } = scenario.setup
  const sandbox: Sandbox = {
    root,
    repositoryDirectory: path.join(root, 'base', repo.name),
    dataDirectory: path.join(root, 'data'),
    stubDir: path.join(root, 'stub'),
  }
  const bareDirectory = path.join(root, 'remotes', repo.owner, `${repo.name}.git`)
  const homeDirectory = path.join(root, 'home')
  const temporaryDirectory = path.join(root, 'tmp')
  for (const directory of [sandbox.repositoryDirectory, sandbox.dataDirectory, sandbox.stubDir, bareDirectory, homeDirectory, temporaryDirectory]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(path.join(root, 'gitconfig'), GIT_CONFIG)

  const token = scenario.setup.ghToken
  const ghBody = token === undefined
    ? 'exit 1\n'
    : `if [ "$1" = auth ] && [ "$2" = token ]; then printf '%s\\n' ${shellQuote(token)}; exit 0; fi\nexit 1\n`
  writeFileSync(path.join(sandbox.stubDir, 'gh'), `#!/bin/sh\n${ghBody}`)
  // git が ssh として呼ぶ形は `fake-ssh <host> <git-upload-pack 'owner/repo.git'>`。host は見ず、bare に向ける。
  writeFileSync(
    path.join(sandbox.stubDir, 'fake-ssh'),
    `#!/bin/sh
cmd="$(eval "printf '%s\\n' $(printf '%s' "$2" | sed 's/^[^ ]* //')")"
prog="\${2%% *}"
exec git "\${prog#git-}" ${shellQuote(path.join(root, 'remotes'))}/"$cmd"
`,
  )
  chmodSync(path.join(sandbox.stubDir, 'gh'), 0o755)
  chmodSync(path.join(sandbox.stubDir, 'fake-ssh'), 0o755)

  // 雛形は空にする。info/exclude の説明文や hooks の sample は、git のバージョンで変わるため。
  const templateDirectory = path.join(root, 'template')
  mkdirSync(templateDirectory)
  const template = `--template=${templateDirectory}`
  git(sandbox, bareDirectory, ['init', '--bare', '-q', '--object-format=sha1', template, '-b', 'main'])
  git(sandbox, sandbox.repositoryDirectory, ['init', '-q', '--object-format=sha1', template, '-b', 'main'])
  mkdirSync(path.join(sandbox.repositoryDirectory, '.git', 'info'))
  writeFileSync(path.join(sandbox.repositoryDirectory, '.git', 'info', 'exclude'), GIT_EXCLUDE)
  git(sandbox, sandbox.repositoryDirectory, ['remote', 'add', 'origin', `git@${repo.host}:${repo.owner}/${repo.name}.git`])
  writeFileSync(path.join(sandbox.repositoryDirectory, 'README.md'), `# ${repo.name}\n`)
  writeFileSync(path.join(sandbox.repositoryDirectory, '.gitignore'), '.pecot/\n')
  commitAll(sandbox, 'initial commit')
  for (const commit of repo.commits) {
    writeFiles(sandbox.repositoryDirectory, commit.files)
    commitAll(sandbox, commit.message)
  }
  git(sandbox, sandbox.repositoryDirectory, ['push', '-q', 'origin', 'main'])
  git(sandbox, sandbox.repositoryDirectory, ['remote', 'set-head', 'origin', 'main'])
  for (const branch of repo.branches) {
    git(sandbox, sandbox.repositoryDirectory, ['checkout', '-q', '-b', branch.name, 'main'])
    for (const commit of branch.commits) {
      writeFiles(sandbox.repositoryDirectory, commit.files)
      commitAll(sandbox, commit.message)
    }
    git(sandbox, sandbox.repositoryDirectory, ['push', '-q', 'origin', branch.name])
    git(sandbox, sandbox.repositoryDirectory, ['checkout', '-q', 'main'])
  }
  if (repo.branch !== 'main') {
    const isExists = repo.branches.some(branch => branch.name === repo.branch)
    git(sandbox, sandbox.repositoryDirectory, isExists ? ['checkout', '-q', repo.branch] : ['checkout', '-q', '-b', repo.branch])
  }
  for (const tag of repo.tags) {
    git(sandbox, sandbox.repositoryDirectory, tag.at === undefined ? ['tag', tag.name] : ['tag', tag.name, tag.at])
    if (tag.isPushed) git(sandbox, sandbox.repositoryDirectory, ['push', '-q', 'origin', `refs/tags/${tag.name}`])
  }
  for (const worktree of repo.worktrees) {
    const worktreeDirectory = path.join(root, worktree.name, repo.name)
    git(sandbox, sandbox.repositoryDirectory, ['worktree', 'add', '-q', worktreeDirectory, '-b', worktree.branch ?? worktree.name])
    writeFiles(worktreeDirectory, worktree.files)
  }
  writeFiles(sandbox.repositoryDirectory, repo.files)
  writeFiles(sandbox.dataDirectory, scenario.setup.data)
  return sandbox
}

export function destroySandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true })
}
