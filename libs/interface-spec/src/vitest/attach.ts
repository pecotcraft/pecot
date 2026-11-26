// テストが判定に使った画面・成果物・出力を、Allure の添付として残す。
// interface-env: NX_TASK_TARGET_TARGET
import { existsSync, readFileSync } from 'node:fs'
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
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.md': 'text/markdown',
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.json', '.md'])

const LABEL_LENGTH = 200

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

// allure-vitest の runtime は添付を同期で送るので、同期の補助からも待たずに呼べる。
export function attachText(name: string, text: string, extension: string): void {
  void attachContent(name, new TextEncoder().encode(text), extension)
}

export function attachJson(name: string, value: unknown): void {
  attachText(name, JSON.stringify(value, undefined, 2), '.json')
}

/**
動かしたコマンドの出力を添付する。空でない stdout・stderr を残し、両方空なら空の stdout を 1 つ残す。終了コードが無ければ名前に書かない
*/
export function attachOutput(command: string, exitCode: number | string | undefined, stdout: string, stderr: string): void {
  const label = `${command.slice(0, LABEL_LENGTH)}${exitCode === undefined ? '' : `（終了コード ${String(exitCode)}）`}`
  if (stdout !== '' || stderr === '') attachText(`${label} stdout`, stdout, '.txt')
  if (stderr !== '') attachText(`${label} stderr`, stderr, '.txt')
}

/**
テスト対象が書き出したファイルを UTF-8 で読み、読んだ中身を添付して返す。型の無い拡張子は .txt で添付する
*/
export function readOutput(filePath: string): string {
  const text = readFileSync(filePath, 'utf8')
  attachReadText(path.basename(filePath), text)
  return text
}

/**
読んだファイルの中身を、ファイル名を名前にして添付する。型は名前の拡張子で決め、型の無い拡張子は .txt にする
*/
export function attachReadText(name: string, text: string): void {
  const extension = path.extname(name)
  attachText(name, text, TEXT_EXTENSIONS.has(extension) ? extension : '.txt')
}
