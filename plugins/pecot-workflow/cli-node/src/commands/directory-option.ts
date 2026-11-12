// -D / --directory の共有スキーマ。typer の exists=True・file_okay=False・dir_okay=True・resolve_path=True と同じ検証。
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'

import { z } from 'zod'

import { pythonStringRepr } from '../domain/python-format.js'

export const DIRECTORY_DESCRIPTION = 'Target Git repository (absolute or relative path)'

function statOf(resolved: string): Stats | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者が渡した -D の値
    return statSync(resolved)
  }
  catch {
    return undefined
  }
}

function isReadable(resolved: string): boolean {
  try {
    accessSync(resolved, constants.R_OK)
    return true
  }
  catch {
    return false
  }
}

function resolvedOf(value: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者が渡した -D の値
    return realpathSync(value)
  }
  catch {
    return value
  }
}

/**
在るディレクトリの実体の絶対パスを返す。誤りの文は typer 0.28（click.Path）と同じで、値は直す前の入力を repr で出す
*/
export const directorySchema = z.string().transform((value, context) => {
  const resolved = resolvedOf(value)
  const stats = statOf(resolved)
  const where = pythonStringRepr(value)
  if (stats === undefined) context.addIssue(`Directory ${where} does not exist.`)
  else if (stats.isFile()) context.addIssue(`Directory ${where} is a file.`)
  else if (!isReadable(resolved)) context.addIssue(`Directory ${where} is not readable.`)
  return resolved
}).describe(DIRECTORY_DESCRIPTION)
