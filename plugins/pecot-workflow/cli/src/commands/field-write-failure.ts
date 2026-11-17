// ボードの選択肢の書き込みの失敗の文。issue-board.ts と issue-shared.ts の両方が使うので、どちらにも置かない（循環 import を避ける）
import type { ProjectConfig } from '../domain/config.js'
import { configSourcePath, projectNameOf } from '../infra/config-store.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import { commandHint, hinted, joinHinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'

/**
選択肢の ID を読み直す案内を 1 回の実行で 1 回だけ出すための印
*/
export interface FieldHintState {
  hasHinted: boolean
}

// 書いた設定のファイルの名前で案内する。.active は、書いた設定と違うことがある
function rereadOptionsHint(config: ProjectConfig): HintedText {
  const configPath = configSourcePath(config)
  const project = configPath === undefined ? placeholder('PROJECT') : projectNameOf(configPath)
  return hinted`hint: if the board options were recreated, run ${commandHint(['project', 'activate'], { project })} to read their IDs again`
}

/**
選択肢の書き込みの失敗の文。古い ID で落ちたとき（VALIDATION）だけ、ID を読み直す案内を添える。
hintState を渡すと案内は 1 回だけ、省くと毎回添える
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 出したことを hintState に書く
export function fieldWriteFailure(message: string, error: Readonly<GitHubAPIError>, config: ProjectConfig, hintState?: FieldHintState): string | HintedText {
  if (error.errorType !== 'VALIDATION' || hintState?.hasHinted === true) return message
  if (hintState !== undefined) hintState.hasHinted = true
  return joinHinted([message, rereadOptionsHint(config)])
}
