import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { collectFiles } from './run.js'
import { parseScenario } from './scenario.js'
import { createSandbox, destroySandbox } from './setup.js'

describe('collectFiles', () => {
  it('サブワークツリー（wt*/<repo>/）の中身を、作業リポジトリからの相対のキーで集める。.git は除く', async () => {
    await explains('シナリオの実行結果に含めるファイルのテストです。サブワークツリー（`wt1/demo/`）の中身が、作業リポジトリからの相対パスをキーとして集められ、`.git` は含まれないことを確認します。')
    const scenario = parseScenario('pr-show-ok', `id: pr-show-ok
tool: pr_show
setup:
  repo:
    commits:
      - message: add files
        files: { a.txt: A, link: { symlink: a.txt } }
    worktrees: [{ name: wt1 }]
    files: { .pecot/x: X }
`)
    const sandbox = createSandbox(scenario)
    try {
      expect(collectFiles(sandbox.root, sandbox.repositoryDirectory, sandbox.dataDirectory, [])).toEqual({
        '.pecot/x': 'X',
        '../../wt1/demo/.gitignore': '.pecot/\n',
        '../../wt1/demo/README.md': '# demo\n',
        '../../wt1/demo/a.txt': 'A',
        '../../wt1/demo/link': { symlink: 'a.txt' },
      })
    }
    finally {
      destroySandbox(sandbox)
    }
  })
})
