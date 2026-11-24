// テストが判定に使った画面や成果物を、Allure の添付として残す。
// interface-env: NX_TASK_TARGET_TARGET
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { attachment } from 'allure-js-commons'

import { isAllureEnabled } from './allure-reporter.js'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function contentType(extension: string): string {
  const type = CONTENT_TYPES[extension]
  if (type === undefined) throw new Error(`添付の型が決まっていない拡張子: ${extension}`)
  return type
}

export async function attachContent(name: string, content: Readonly<Uint8Array>, extension: string): Promise<void> {
  // reporter の無いところで呼ぶと、allure-js-commons が呼ぶたびに警告を標準出力に出す。
  if (!isAllureEnabled(process.env)) return
  await attachment(name, content, { contentType: contentType(extension), fileExtension: extension })
}

// attachmentPath は reporter が後で読むので、afterAll で消す成果物が抜ける。中身を読んで渡す。
export async function attachFile(name: string, filePath: string): Promise<void> {
  if (!isAllureEnabled(process.env)) return
  const extension = path.extname(filePath)
  contentType(extension)
  // ファイルが無いことは、テストに元からある判定が文言を出して落とす。
  if (!existsSync(filePath)) return
  await attachContent(name, await readFile(filePath), extension)
}
