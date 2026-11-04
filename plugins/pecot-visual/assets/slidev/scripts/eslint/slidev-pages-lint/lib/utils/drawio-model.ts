import fs from 'fs';
import { parseDrawio } from '@v-slidev/eslint-shared';
import type { DrawioModel } from '@v-slidev/eslint-shared';

// 同じ図を複数ページ・複数ステップ・複数規則で参照しても解析は 1 回にする（mtime で無効化）
const modelCache = new Map<string, { mtimeMs: number; model: DrawioModel }>();
export function loadModel(xmlPath: string): DrawioModel {
  const { mtimeMs } = fs.statSync(xmlPath);
  const cached = modelCache.get(xmlPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.model;
  }
  const model = parseDrawio(fs.readFileSync(xmlPath, 'utf-8'));
  modelCache.set(xmlPath, { mtimeMs, model });
  return model;
}
