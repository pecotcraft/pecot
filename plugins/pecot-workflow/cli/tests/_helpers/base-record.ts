// session start が書く、開発ブランチから着手した記録（.pecot-base）。テストの準備で既定に置く
export interface BaseRecordOption {
  /**
  開発ブランチから着手した記録を置くか。既定は置く。false なら置かず、スタック先を判定から求める
  */
  readonly baseRecord?: boolean
}

// 位置は読まれないので、形だけ合わせる
const DEVELOPMENT_RECORD: Readonly<Record<string, string>> = { '.pecot/state/.pecot-base': `main ${'0'.repeat(40)}\n` }

export function developmentRecordOf(options: Readonly<BaseRecordOption>): Readonly<Record<string, string>> {
  return options.baseRecord === false ? {} : DEVELOPMENT_RECORD
}
