import yaml from 'js-yaml';

const SEPARATOR_REGEX = /^---\s*$/;

export function extractFrontmatterText(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  const lines = text.split('\n');

  if (!SEPARATOR_REGEX.test(lines[0])) {
    return null;
  }

  for (let i = 1; i < lines.length; i++) {
    if (SEPARATOR_REGEX.test(lines[i])) {
      const yamlLines = lines.slice(1, i);
      return yamlLines.join('\n');
    }
  }

  return null;
}

export function parseFrontmatter(text: string): unknown {
  const yamlText = extractFrontmatterText(text);
  if (yamlText === null) {
    return null;
  }

  try {
    const result = yaml.load(yamlText);
    if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

export type FrontmatterBase = { layout?: string; [k: string]: unknown };
