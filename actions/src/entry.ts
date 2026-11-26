// action の起動の共通部分。案内の形を登録し、inputs を読み、token を渡し、終了コードを step の成否にする。
import process from 'node:process'

import { getInput, setFailed, setSecret } from '@actions/core'
import { z } from 'zod'

import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { FAILURE_EXIT_CODE, isReportableFailure, reportFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { registerHintCatalog } from '@pecot/workflow-core/commands-shared/hint-catalog.js'
import { getEnvironmentVariableName } from '@pecot/workflow-core/infra/github/auth.js'
import { TransportFailure } from '@pecot/workflow-core/infra/github/client.js'

/**
action が呼ぶ処理。入力は schema で確かめてから run に渡す
*/
export interface ActionCommand<Input extends z.ZodType> {
  readonly input: Input
  readonly run: (input: z.output<Input>, io: CommandIo) => Promise<number>
}

const USAGE_EXIT_CODE = 2

/**
action のログに書く io。行は処理が組み立てたものをそのまま出す
*/
export function actionIo(): CommandIo {
  return {
    stdout: (text: string) => {
      // eslint-disable-next-line no-restricted-syntax -- action のログへの書き出しはここだけ
      process.stdout.write(text)
    },
    stderr: (text: string) => {
      // eslint-disable-next-line no-restricted-syntax -- action のログへの書き出しはここだけ
      process.stderr.write(text)
    },
  }
}

/**
空の input は未指定として undefined を返す
*/
export function optionalInput(name: string): string | undefined {
  const value = getInput(name)
  return value === '' ? undefined : value
}

/**
空の input も値として返す。空に意味がある input に使う
*/
export function rawInput(name: string): string {
  return getInput(name)
}

/**
true・false の input。空は undefined（処理の既定値になる）。それ以外の文字は処理の schema が断る
*/
export function booleanInput(name: string): boolean | string | undefined {
  const value = optionalInput(name)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/**
整数の input。空は undefined。数でない文字は処理の schema が断る
*/
export function integerInput(name: string): number | string | undefined {
  const value = optionalInput(name)
  if (value === undefined) return undefined
  return /^-?\d+$/.test(value) ? Number(value) : value
}

/**
Issue・PR の参照の input。番号だけなら、ワークフローが動くリポの owner/repo/N にする
*/
export function referenceInput(name: string): string | undefined {
  const value = optionalInput(name)
  if (value === undefined || !/^\d+$/.test(value)) return value
  const repository = process.env['GITHUB_REPOSITORY'] ?? ''
  return repository === '' ? value : `${repository}/${value}`
}

/**
token の input を、処理の GitHub のクライアントが読む環境変数に渡す。ホストはワークフローの動く GitHub（GITHUB_SERVER_URL）
*/
function passToken(): void {
  const token = getInput('token')
  if (token.length === 0) return
  setSecret(token)
  const host = URL.parse(process.env['GITHUB_SERVER_URL'] ?? '')?.hostname ?? 'github.com'
  process.env[getEnvironmentVariableName(host)] = token
}

/**
入力を確かめて処理を呼び、終了コードを返す。0 でなければ step を失敗にする
*/
export async function runAction<Input extends z.ZodType>(command: Readonly<ActionCommand<Input>>, raw: Readonly<Record<string, unknown>>, io: CommandIo = actionIo()): Promise<number> {
  registerHintCatalog()
  passToken()
  const defined = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined))
  const parsed = command.input.safeParse(defined)
  if (!parsed.success) {
    io.stderr(`error: invalid input: ${z.prettifyError(parsed.error)}\n`)
    return fail(USAGE_EXIT_CODE)
  }
  let code: number
  try {
    code = await command.run(parsed.data, io)
  }
  catch (error: unknown) {
    code = exitCodeOf(error, io)
  }
  return code === 0 ? 0 : fail(code)
}

// 設定の誤り・トークンの不足などは、CLI と同じく error の行にする。それ以外はプログラムの誤りなので伝える
function exitCodeOf(error: unknown, io: CommandIo): number {
  if (error instanceof CommandExit) return error.exitCode
  if (error instanceof TransportFailure) {
    io.stderr(`error: ${error.message}\n`)
    return FAILURE_EXIT_CODE
  }
  if (!isReportableFailure(error)) throw error
  reportFailure(error, io)
  return FAILURE_EXIT_CODE
}

function fail(code: number): number {
  setFailed(`exit code ${String(code)}`)
  process.exitCode = code
  return code
}
