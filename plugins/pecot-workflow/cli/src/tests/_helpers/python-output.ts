/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは tests/python-output/ 配下の fixture だけ */
// Python の CLI の出力を記録した fixture（tests/python-output/*.json）を読む補助。
//
// fixture は入力と Python の出力の対で、作り直さない記録。
// テストは期待値を文字の組み立てで作らず、ここから逐語で受け取る。
// 形は zod で確かめる。形が崩れていれば、読み込みの時点で落とす。
//
// 使い方は次のとおり。
// - frontmatterOutputs() は、YAML と期待の対の表を返す。
// - sectionsOutputs() は、本文ごとの検証結果を返す。
// - worktreeConfigOutputs() は、WorktreeConfig の入力と、エラー文または保存結果を返す。
// - validationErrorOutput(id) は、id の入力と検証エラーの文を返す。入力が文字列なら validationErrorTextOutput(id)。
// - inputValueOutputs() は、入力値と、エラー文に出る input_value を返す。
// - httpQueryOutput() は、REST の要求に付くクエリ文字列を返す。
// - queriesOutput() は、queries.py の定数名と、gql が送る形の文を返す。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import type { JsonValue } from '../../domain/python-format.js'
import { parseJson } from './json.js'

const directory = path.resolve(import.meta.dirname, '../../../tests/python-output')

function load(name: string): unknown {
  return parseJson(readFileSync(path.join(directory, `${name}.json`), 'utf8'))
}

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const JsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([JsonScalarSchema, JsonArraySchema, JsonObjectSchema]))
const JsonArraySchema = z.array(JsonSchema)
const JsonObjectSchema = z.record(z.string(), JsonSchema)

// frontmatter

const OkSchema = z.object({ ok: z.record(z.string(), z.unknown()) })
const ErrorSchema = z.object({ error: z.string() })
const ResultSchema = z.union([OkSchema, ErrorSchema])
export type FrontmatterResult = z.infer<typeof ResultSchema>

const RowSchema = z.tuple([z.string(), ResultSchema])
const TableSchema = z.array(RowSchema)

const FrontmatterSchema = z.object({
  issue: TableSchema,
  keyAndTag: TableSchema,
  comment: TableSchema,
  pullRequest: TableSchema,
  yamlFailures: z.array(z.string()),
})

export function frontmatterOutputs(): z.infer<typeof FrontmatterSchema> {
  return FrontmatterSchema.parse(load('frontmatter'))
}

// sections

const HeadingSchema = z.object({ level: z.number(), name: z.string() })
const MessagesSchema = z.array(z.string())
const MessageGroupsSchema = z.array(MessagesSchema)
const SectionsCaseSchema = z.object({
  body: z.string(),
  style: MessagesSchema,
  sections: MessageGroupsSchema,
  summaries: MessageGroupsSchema,
  balance: MessagesSchema,
  closed: MessageGroupsSchema,
  fold: MessagesSchema,
})
const SectionsSchema = z.object({
  required: z.array(z.array(HeadingSchema)),
  closedHeadingsByTemplate: z.record(z.string(), z.string()),
  cases: z.array(SectionsCaseSchema),
})

export function sectionsOutputs(): z.infer<typeof SectionsSchema> {
  return SectionsSchema.parse(load('sections'))
}

// worktree-config

const WorktreeCaseSchema = z.object({ name: z.string(), input: JsonSchema, error: z.string().optional(), saved: z.string().optional() })
const WorktreeConfigSchema = z.object({
  cases: z.array(WorktreeCaseSchema),
  defaultConfigSaved: z.string(),
  defaultConfigWithSelfSaved: z.string(),
  defaultIgnoreContent: z.string(),
})

export function worktreeConfigOutputs(): z.infer<typeof WorktreeConfigSchema> {
  return WorktreeConfigSchema.parse(load('worktree-config'))
}

// validation-errors

const ValidationErrorCaseSchema = z.object({ id: z.string(), kind: z.string(), input: JsonSchema, message: z.string() })
const ValidationErrorsSchema = z.object({ cases: z.array(ValidationErrorCaseSchema) })

export function validationErrorOutput(id: string): { readonly input: JsonValue, readonly message: string } {
  const found = ValidationErrorsSchema.parse(load('validation-errors')).cases.find(item => item.id === id)
  if (found === undefined) throw new Error(`validation-errors.json に id が無い: ${id}`)
  return found
}

/**
入力が文字列の id。入力と、検証エラーの文
*/
export function validationErrorTextOutput(id: string): { readonly input: string, readonly message: string } {
  const { input, message } = validationErrorOutput(id)
  if (typeof input !== 'string') throw new TypeError(`入力が文字列ではない: ${id}`)
  return { input, message }
}

// input-values

const InputValueCaseSchema = z.object({ name: z.string(), input: JsonSchema, inputValue: z.string() })
const InputValuesSchema = z.object({ cases: z.array(InputValueCaseSchema) })

export function inputValueOutputs(): z.infer<typeof InputValuesSchema>['cases'] {
  return InputValuesSchema.parse(load('input-values')).cases
}

// http-query

const HttpQueryCaseSchema = z.object({ params: JsonSchema, query: z.string() })
const HttpQuerySchema = z.object({ cases: z.array(HttpQueryCaseSchema) })

export function httpQueryOutput(): string {
  const [first] = HttpQuerySchema.parse(load('http-query')).cases
  if (first === undefined) throw new Error('http-query.json が空')
  return first.query
}

// queries

const QueriesSchema = z.record(z.string(), z.string())

/**
queries.py の定数名と、gql が送る形の文
*/
export function queriesOutput(): Readonly<Record<string, string>> {
  return QueriesSchema.parse(load('queries'))
}
