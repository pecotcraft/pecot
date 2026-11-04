import { createSyncFn } from 'synckit';
import type { Syncify } from 'synckit';
import type { TextFinding, TextMode } from '@pecot/text-rules';

// テスト（strip-types で .ts 実行）と本番（dist の .js）の両方で worker を解決する
const workerExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const defaultWorkerPath = new URL(`./worker${workerExtension}`, import.meta.url);

type LintFn = Syncify<(text: string, mode: TextMode) => Promise<readonly TextFinding[]>>;

let workerPath = defaultWorkerPath;
let lintSync: LintFn | undefined;

// worker の起動は辞書読み込みで約 200ms かかるため、最初の対象文字列が現れるまで遅らせる
export function lintText(text: string, mode: TextMode = 'fragment'): readonly TextFinding[] {
  lintSync ??= createSyncFn(workerPath) as LintFn;
  return lintSync(text, mode);
}

// worker の起動失敗を再現するテスト用。引数なしで既定の worker に戻す
export function useWorkerForTest(path: URL = defaultWorkerPath): void {
  workerPath = path;
  lintSync = undefined;
}
