// talk-dir の package.json を生成する。
// テーマを 1 つ参照する package.json を作る（slide create と、slide sync のテーマへの移行）。

export interface TalkPackageJsonInput {
  /**
  talk-dir の名前。
  */
  readonly name: string
  /**
  テーマのパッケージ名。`dependencies` のキーになる。
  */
  readonly themeName: string
  /**
  テーマの取得元。`dependencies` の値になる（git URL とタグ、または `file:` のパス）。
  */
  readonly themeSpec: string
}

/**
slide create が生成する package.json の全文を返す。
依存はテーマ 1 つだけで、そのほかの依存は実行用ミラーの node_modules から張る。
*/
export function talkPackageJsonSource(input: Readonly<TalkPackageJsonInput>): string {
  const data = {
    name: input.name,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { [input.themeName]: input.themeSpec },
  }
  return `${JSON.stringify(data, undefined, 2)}\n`
}
