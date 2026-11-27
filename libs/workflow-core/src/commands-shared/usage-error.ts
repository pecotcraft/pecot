// 入力の誤り。ツールの結果の文は例外の文そのもので、終了コードは 2。
import { BaseError } from '../domain/errors.js'

export class UsageError extends BaseError {}

export const USAGE_EXIT_CODE = 2
