/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
// session show のテストが共有する準備。
import { realpathSync } from 'node:fs'

import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { developmentRecordOf } from './base-record.js'
import type { BaseRecordOption } from './base-record.js'
import { setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

const ORIGIN_URL = 'https://ghes.example.com/acme/demo.git'

export interface SessionCaseOptions extends BaseRecordOption {
  /**
  既定は feat/demo/7
  */
  readonly branch?: string
  /**
  追加する remote（名前 → URL）。既定は origin だけ
  */
  readonly remotes?: Readonly<Record<string, string>>
  /**
  プロジェクトルートに足すファイル（設定ファイルの上書きを含む）
  */
  readonly files?: Readonly<Record<string, string>>
  /**
  設定のリポジトリ名（owner は acme）。既定は demo だけ
  */
  readonly repositories?: readonly string[]
}

export interface SessionCase {
  readonly project: ProjectFixture
  readonly repository: string
}

/**
一時のプロジェクトルートを git リポにして、cwd をそこへ移す。ブランチと remote で作業中の Issue が決まる
*/
export function prepareSession(options: Readonly<SessionCaseOptions> = {}): SessionCase {
  const { branch = 'feat/demo/7', remotes = { origin: ORIGIN_URL }, files = {} } = options
  const project = setUpProject({ files: { ...developmentRecordOf(options), ...files }, ...options.repositories !== undefined && { repositories: [...options.repositories] } })
  const repository = realpathSync(createGitRepository(undefined, project.root))
  process.chdir(repository)
  gitForTest(repository, ['checkout', '-q', '-b', branch])
  for (const [name, url] of Object.entries(remotes)) gitForTest(repository, ['remote', 'add', name, url])
  return { project, repository }
}
