// ボードの選択肢の書き込みの失敗の文。issue-board.ts と issue-shared.ts の両方が使うので、どちらにも置かない（循環 import を避ける）
import path from 'node:path'

import { getActiveConfigPath, projectsDirectory } from '../infra/config-store.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import { commandHint, hinted, joinHinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'

/**
選択肢の ID を読み直す案内を 1 回の実行で 1 回だけ出すための印
*/
export interface FieldHintState {
  hasHinted: boolean
}

function rereadOptionsHint(): HintedText {
  const configPath = getActiveConfigPath()
  // projects/ の外の config は、ファイル名では project activate が見つけられない
  const project = configPath === undefined
    ? placeholder('PROJECT')
    : (path.dirname(configPath) === projectsDirectory() ? path.basename(configPath, '.json') : configPath)
  return hinted`hint: if the board options were recreated, run ${commandHint(['project', 'activate'], { project })} to read their IDs again`
}

/**
選択肢の書き込みの失敗の文。古い ID で落ちたとき（VALIDATION）だけ、ID を読み直す案内を添える。
hintState を渡すと案内は 1 回だけ、省くと毎回添える
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 出したことを hintState に書く
export function fieldWriteFailure(message: string, error: Readonly<GitHubAPIError>, hintState?: FieldHintState): string | HintedText {
  if (error.errorType !== 'VALIDATION' || hintState?.hasHinted === true) return message
  if (hintState !== undefined) hintState.hasHinted = true
  return joinHinted([message, rereadOptionsHint()])
}
