import { describe, expect, it } from 'vitest'

import { runScenario } from './run.js'
import { parseScenario } from './scenario.js'

describe('runScenario の files', () => {
  it('サブワークツリー（wt*/<repo>/）の中身を、作業リポからの相対のキーで集める。.git は除く', async () => {
    const scenario = parseScenario('issue-read-ok', `id: issue-read-ok
command: { path: [issue, read] }
setup:
  repo:
    commits:
      - message: add files
        files: { a.txt: A, link: { symlink: a.txt } }
    worktrees: [{ name: wt1 }]
    files: { .pecot/x: X }
`)
    const outcome = await runScenario(scenario, { command: 'true', args: [], env: {} })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.files).toEqual({
      '.pecot/x': 'X',
      '../../wt1/demo/.gitignore': '.pecot/\n',
      '../../wt1/demo/README.md': '# demo\n',
      '../../wt1/demo/a.txt': 'A',
      '../../wt1/demo/link': { symlink: 'a.txt' },
    })
  })
})
