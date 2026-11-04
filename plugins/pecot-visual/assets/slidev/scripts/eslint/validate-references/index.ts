#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateSchema } from './lib/schema-validator.ts';
import { validateSemantics } from './lib/semantic-validator.ts';

const SKIP_FILES = new Set(['_template.yaml']);

interface ValidationError {
  layer: string;
  rule?: string;
  path?: string;
  message: string;
}

interface FileResult {
  file: string;
  errors: ValidationError[];
}

export function validateFile(filePath: string): FileResult {
  const errors: ValidationError[] = [];

  let data: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    data = yaml.load(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ layer: 'parse', message: `YAML parse error: ${message}` });
    return { file: filePath, errors };
  }

  if (data == null || typeof data !== 'object') {
    errors.push({ layer: 'parse', message: 'YAML content is not an object' });
    return { file: filePath, errors };
  }

  const schemaResult = validateSchema(data);
  for (const err of schemaResult.errors) {
    errors.push({ layer: 'schema', path: err.path, message: err.message });
  }

  const semanticErrors = validateSemantics(data, filePath);
  for (const err of semanticErrors) {
    errors.push({ layer: 'semantic', rule: err.rule, message: err.message });
  }

  return { file: filePath, errors };
}

interface ValidateAllResult {
  results: FileResult[];
  totalErrors: number;
}

export function validateAll(dir: string): ValidateAllResult {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !SKIP_FILES.has(f))
    .sort();

  const results = files.map((f) => validateFile(join(dir, f)));
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

  return { results, totalErrors };
}

function main(): void {
  const args = process.argv.slice(2);

  const dirIndex = args.indexOf('--dir');
  const dirArgument = dirIndex === -1 ? undefined : args[dirIndex + 1];
  if (!dirArgument) {
    console.error('Usage: validate-references --dir <references のディレクトリ>');
    process.exitCode = 1;
    return;
  }
  const dir = resolve(dirArgument);

  console.log(`Validating: ${dir}\n`);

  const { results, totalErrors } = validateAll(dir);

  for (const result of results) {
    const fileName = result.file.split('/').pop();
    if (result.errors.length === 0) {
      console.log(`  ✓ ${fileName}`);
    } else {
      console.log(`  ✗ ${fileName}`);
      for (const err of result.errors) {
        const prefix = err.rule || err.path || err.layer;
        console.log(`    [${prefix}] ${err.message}`);
      }
    }
  }

  console.log(`\n${results.length} files checked, ${totalErrors} error(s) found.`);

  // process.exit() ではなく exitCode を立てる。pipe 越し（hook の command substitution）に
  // 大量の違反を流すと、process.exit() が未フラッシュの stdout を切り捨て、末尾の
  // 完走フッターごと消える。フッターは hook 側で「完走したか」の判定に使うため、
  // 消えると違反がクラッシュ（未実施）に化ける。
  process.exitCode = totalErrors > 0 ? 1 : 0;
}

// import.meta.url は symlink を解決した実体パスを指すため、argv[1] 側も realpath に揃える。
// 揃えないと symlink を含むパスでの起動で一致せず、何も出力せず exit 0 で終わる。
// validateAll をライブラリとして import する場合、argv[1] が実ファイルでないことがある。
// そのため realpathSync の例外は、自己実行ではないものとして false を返す。
// プラグイン側の scripts/release/self-exec.mjs と同じ判定だが、このファイルは talk-dir へ配布される。
// 配布されるテンプレートの一部で、プラグイン側の共有モジュールを import できないため、直書きしている。
function isSelfExecuted(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const isMain = isSelfExecuted();

if (isMain) {
  main();
}
