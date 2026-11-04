// domain/slidev-theme の port `ThemeFiles` を node:fs で実装する。
// テーマの置き場は呼び出し側が決めた path で、固定の literal にはならない。
/* eslint-disable security/detect-non-literal-fs-filename */

import { readdir, readFile } from 'node:fs/promises'

import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'

export class NodeThemeFiles implements ThemeFiles {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    }
    catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async listFiles(directory: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.filter(entry => !entry.isDirectory()).map(entry => entry.name).toSorted((a, b) => a.localeCompare(b))
    }
    catch (error: unknown) {
      if (isMissing(error)) return []
      throw error
    }
  }
}

// ENOENT と、ディレクトリでないものを開いた ENOTDIR は「無い」として扱う。
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
