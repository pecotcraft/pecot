// pr と session finish のテストが共有する、一時の作業場所の読み方。

/**
空でない行
*/
export function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

/**
状態のファイルの、作業場所からの相対パス
*/
export function stateFile(name: string): string {
  return `.pecot/state/${name}`
}
