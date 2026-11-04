// drawio domain で共有する型定義。
// url.ts の純粋関数群と infra/drawio/icons.ts の icon resolver 実装が
// 双方ともこのモジュールを参照する。

export type IconResolver = (relativePath: string, color?: string) => string | undefined

export interface GenerateDrawioUrlOptions {
  readonly mode: 'view' | 'edit'
}
