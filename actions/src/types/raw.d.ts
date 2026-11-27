// rollup の scripts/raw-text.mjs と vitest が、`?raw` の import をファイルの文字列にする
declare module '*?raw' {
  const text: string
  export default text
}
