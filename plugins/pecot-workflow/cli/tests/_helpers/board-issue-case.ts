// MCP のサーバのテストが使う、一時のプロジェクトと origin を持つ git リポの準備。
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'
import { stepSync } from './step.js'

export const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
const ORIGIN_URL = 'https://ghes.example.com/acme/demo.git'

// 設定の workflow に載せるオプション。fixtureConfig（interface-case.ts）と同じ値
const WORKFLOW_OPTIONS: Readonly<Record<string, string>> = { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }

export interface ProjectCaseOptions {
  /**
  設定の repositories に載せるリポジトリ名。既定は demo だけ
  */
  readonly repositories?: readonly string[]
  /**
  ボードが定義しない status
  */
  readonly missingStatus?: string
  /**
  設定の workflow に blocked（o7）を載せる
  */
  readonly hasBlocked?: boolean
}

export interface ProjectCase {
  readonly project: ProjectFixture
  /**
  cwd が移った先の一時 git リポジトリ。origin は acme/demo
  */
  readonly repository: string
}

function buildConfig(missingStatus: string | undefined, hasBlocked: boolean, repositories: readonly string[]): string {
  const base = hasBlocked ? { ...WORKFLOW_OPTIONS, blocked: 'o7' } : WORKFLOW_OPTIONS
  const options = Object.fromEntries(Object.entries(base).filter(([name]) => name !== missingStatus))
  const fields = { workflow: { id: 'PVTSSF_workflow', options } }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields }
  const config = {
    host: 'ghes.example.com',
    owner: 'acme',
    project,
    repositories: repositories.map(name => ({ owner: 'acme', name, develop_branch: 'main' })),
  }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
一時のプロジェクトルートと、origin を持つ一時 git リポジトリを用意する
*/
export function prepareProject(options: Readonly<ProjectCaseOptions> = {}): ProjectCase {
  return stepSync('プロジェクトと git のリポを用意する', () => buildProject(options))
}

function buildProject(options: Readonly<ProjectCaseOptions>): ProjectCase {
  const { repositories = ['demo'], missingStatus, hasBlocked = false } = options
  const files = missingStatus === undefined && !hasBlocked ? {} : { [`.pecot/config/projects/${CONFIG_FILE}`]: buildConfig(missingStatus, hasBlocked, repositories) }
  const project = setUpProject({ repositories, files })
  const repository = enterGitRepository()
  gitForTest(repository, ['remote', 'add', 'origin', ORIGIN_URL])
  return { project, repository }
}
