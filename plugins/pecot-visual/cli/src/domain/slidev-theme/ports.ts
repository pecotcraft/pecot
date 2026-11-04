// テーマのパッケージを読む port。domain は fs を直接触らず、infra の実装を受け取る。

export interface ThemeFiles {
  // テキストを読む。無ければ undefined。
  readText(path: string): Promise<string | undefined>
  // ディレクトリ直下のファイル名（ディレクトリは含まない）を返す。ディレクトリが無ければ空配列。
  listFiles(directory: string): Promise<readonly string[]>
}
