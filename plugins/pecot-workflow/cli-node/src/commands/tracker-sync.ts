// Tracker に反映するコマンドと、PR の後片付けが共有する出力の補助。

import type { Operation, Output } from './output.js'

/**
API を呼ばない操作の行を出す。dry-run では計画、実行では結果になる
*/
export function settle(out: Output, operation: Operation): void {
  out.planned(operation)
  out.done(operation)
}
