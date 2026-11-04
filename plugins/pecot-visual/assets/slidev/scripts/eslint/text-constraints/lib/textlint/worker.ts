import { lintText } from '@pecot/text-rules';
import type { TextMode } from '@pecot/text-rules';
import { runAsWorker } from 'synckit';

// ESLint の規則は同期、textlint は非同期。synckit のワーカーが非同期の結果を待ち、呼び出し側へ同期的に返す。
runAsWorker((text: string, mode: TextMode) => lintText(text, mode));
