/* eslint-disable security/detect-non-literal-fs-filename -- パスは雛形の一覧の置き先と、利用者が渡した -D から決まる */
// ワークフローの雛形を読み、導入先のリポに書き出す。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { WorkflowTemplate } from '@pecot/workflow-core/domain/workflow-template.js'
import { templatesDirectory } from './template-store.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'

/**
同梱の雛形の中身
*/
export function readBundledWorkflow(template: Readonly<WorkflowTemplate>): string {
  return readTextFile(path.join(templatesDirectory('workflow'), template.templateFile))
}

/**
リポに置いたファイルの中身。無ければ undefined
*/
export function readInstalledWorkflow(root: string, template: Readonly<WorkflowTemplate>): string | undefined {
  const file = path.join(root, template.destination)
  return existsSync(file) ? readTextFile(file) : undefined
}

/**
置き先に書き出す。ディレクトリが無ければ作る
*/
export function writeWorkflow(root: string, template: Readonly<WorkflowTemplate>, content: string): void {
  const file = path.join(root, template.destination)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}
