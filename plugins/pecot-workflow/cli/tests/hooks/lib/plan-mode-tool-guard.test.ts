/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// exit-plan-remind.sh の tool 名ガードと --mode の検証のテスト。
// frontmatter の matcher で絞られるが、単体で呼ばれたときの防御として、冒頭で ExitPlanMode 以外を弾く。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { checkoutWorkBranch, gitRepository } from '../_helpers/git.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'
import { explains } from '../../_helpers/explains.js'

const EXIT_PLAN_REMIND = path.join(hooksDirectory, 'lib', 'post-tool-use', 'exit-plan-remind.sh')

// git のリポを project にし、作業中の Issue のブランチへ切り替える。
function setUpGuard(hookCase: HookCase): void {
  const project = gitRepository(hookCase, 'project')
  mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  checkoutWorkBranch(hookCase, project, 'x/1')
}

describe('exit-plan-remind.sh', () => {
  it.for(['{"tool_name":"bash","tool_input":{"command":"ls"}}', '{"tool_name":"Bash"}', '{"tool_name":"exit_plan_mode"}', '{"tool_name":"exit_plan"}'])(
    '作業中の Issue があっても、ExitPlanMode 以外の入力 %s のとき、何も出力しない',
    async (stdin) => {
      await explains(`\`exit-plan-remind.sh\` のテストです。ExitPlanMode 以外のツールの入力（\`${stdin}\`）の場合に、作業中の Issue があっても、何も出力しないことを確認します。`)
      const hookCase = createHookCase()
      setUpGuard(hookCase)
      const result = runScript(hookCase, EXIT_PLAN_REMIND, ['--mode=active'], { stdin })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    },
  )

  it.for([{ args: [] }, { args: ['--mode=other'] }, { args: ['--mode='] }, { args: ['--mode'] }])('--mode が無いか不正（$args）のとき、stderr に出して終了コード 1 で終わる', async ({ args }) => {
    await explains(`\`exit-plan-remind.sh\` の引数のテストです。\`--mode\` が指定されていないか不正な場合（\`${JSON.stringify(args)}\`）に、標準エラー出力へエラーを出力し、終了コード 1 で終了することを確認します。`)
    const hookCase = createHookCase()
    setUpGuard(hookCase)
    const result = runScript(hookCase, EXIT_PLAN_REMIND, args, { stdin: '{"tool_name":"ExitPlanMode"}' })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('exit-plan-remind: --mode must be active or quick')
  })
})
