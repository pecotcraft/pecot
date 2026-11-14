// #412・#428 で変えた main の古いコマンド名と入力名。CLI と MCP が案内に使い、skills のテストが古い名前を拾うのに使う。次の major で消す

/**
古い名前から新しい名前への表。キーは main のコマンド名で、値は今の名前
*/
export const RENAMED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['add-to-project', 'board add'],
  ['update-issue-status', 'board move'],
  ['create-branch', 'session start'],
  ['delete-branch', 'branch delete'],
  ['dependabot sync', 'tracker sync dependabot'],
  ['security sync', 'tracker sync security'],
  ['project info', 'board show'],
  ['project set-repo', 'project link'],
  ['project set-aggregation-repo', 'project set aggregation_repo'],
  ['project unset-aggregation-repo', 'project unset aggregation_repo'],
  ['project show-aggregation-repo', 'project get aggregation_repo'],
  ['issue read', 'issue show'],
  ['pr read', 'pr show'],
  ['pr preflight', 'pr check'],
  ['pr cleanup', 'session finish'],
  ['release preflight', 'release check'],
  ['session status', 'session show'],
  ['issue quick', 'issue create --freeform'],
])

/**
解決が止まった path の古い名前と新しい名前。`dependabot` のように 1 語目で止まったときは、その語で始まる古い名前を返す。無ければ undefined
*/
export function findRenamedCommand(path: readonly string[]): readonly [string, string] | undefined {
  const prefix = path.join(' ')
  return [...RENAMED_COMMANDS].find(([oldName]) => oldName === prefix || oldName.startsWith(`${prefix} `))
}

/**
古い入力名。command はコマンド名、oldName は古い入力名、newName は今の入力名
*/
export interface RenamedInput {
  readonly command: string
  readonly oldName: string
  readonly newName: string
}

export const RENAMED_INPUTS: readonly RenamedInput[] = [
  { command: 'issue comment', oldName: 'issue', newName: 'issue_ref' },
  { command: 'session restore', oldName: 'issue', newName: 'issue_ref' },
  { command: 'branch delete', oldName: 'repo_ref', newName: 'repo' },
  { command: 'project link', oldName: 'owner_repo', newName: 'repo' },
  { command: 'session start', oldName: 'branch_name', newName: 'branch' },
  { command: 'issue create', oldName: 'plan', newName: 'dry_run' },
]

/**
path のコマンドの古い入力名 name の、今の入力名。無ければ undefined
*/
export function findRenamedInput(path: readonly string[], name: string): string | undefined {
  const command = path.join(' ')
  return RENAMED_INPUTS.find(entry => entry.command === command && entry.oldName === name)?.newName
}

/**
誤りの文に添える、古い名前から今の名前への案内
*/
export function renamedInputNote(oldName: string, newName: string): string {
  return ` ('${oldName}' was renamed to '${newName}')`
}
