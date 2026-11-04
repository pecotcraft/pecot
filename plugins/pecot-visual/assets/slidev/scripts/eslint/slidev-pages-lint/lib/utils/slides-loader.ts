import fs from 'fs';
import path from 'path';

const slidesCache = new Map<string, Set<string>>();

const SRC_REGEX = /^\s*src:\s+(.+)/gm;

export function findSlidesFile(filePath: string): string | null {
  const normalized = path.normalize(filePath);
  const separator = path.sep + 'pages' + path.sep;
  const pagesIndex = normalized.lastIndexOf(separator);
  if (pagesIndex === -1) {
    return null;
  }
  const parentDir = normalized.substring(0, pagesIndex);
  const slidesPath = path.join(parentDir, 'slides.md');
  try {
    if (!fs.existsSync(slidesPath)) {
      return null;
    }
  } catch {
    return null;
  }
  return slidesPath;
}

export function getSlidesEntries(slidesFilePath: string): Set<string> {
  const cached = slidesCache.get(slidesFilePath);
  if (cached) {
    return cached;
  }

  const entries = new Set<string>();
  try {
    const content = fs.readFileSync(slidesFilePath, 'utf-8');
    const slidesDir = path.dirname(slidesFilePath);
    let match: RegExpExecArray | null;
    while ((match = SRC_REGEX.exec(content)) !== null) {
      const srcValue = match[1].trim();
      const absolutePath = path.resolve(slidesDir, srcValue);
      entries.add(absolutePath);
    }
  } catch {
    // 読み込み失敗時は空Setを返す
  }

  slidesCache.set(slidesFilePath, entries);
  return entries;
}

export function clearSlidesCache(): void {
  slidesCache.clear();
}
