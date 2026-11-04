export interface StyleBlock {
  css: string;
  startIndex: number;
}

export interface CssPropertyMatch {
  value: string;
  index: number;
}

export interface RuleBlock {
  selector: string;
  body: string;
}

export function extractStyleBlocks(sourceText: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let match: RegExpExecArray | null;

  while ((match = styleRegex.exec(sourceText)) !== null) {
    blocks.push({
      css: match[1],
      startIndex: match.index,
    });
  }

  return blocks;
}

export function findCssProperty(cssText: string, property: string): CssPropertyMatch[] {
  const results: CssPropertyMatch[] = [];
  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const propRegex = new RegExp(
    `${escapeRegex(property)}\\s*:\\s*([^;}]+)`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(cleanCss)) !== null) {
    results.push({
      value: match[1].trim(),
      index: match.index,
    });
  }

  return results;
}

export function findCssPropertyWithValue(
  cssText: string,
  property: string,
  valuePattern: RegExp,
): CssPropertyMatch[] {
  const properties = findCssProperty(cssText, property);
  return properties.filter((prop) => valuePattern.test(prop.value));
}

export function classHasProperty(cssText: string, className: string, property: string): boolean {
  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const classRegex = new RegExp(
    `\\.${escapeRegex(className)}(?:[^{]*?)\\{([^}]+)\\}`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(cleanCss)) !== null) {
    const rulesText = match[1];
    const propRegex = new RegExp(`${escapeRegex(property)}\\s*:`);
    if (propRegex.test(rulesText)) {
      return true;
    }
  }

  return false;
}

export function extractRuleBlocks(cssText: string): RuleBlock[] {
  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: RuleBlock[] = [];
  const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(cleanCss)) !== null) {
    blocks.push({
      selector: match[1].trim(),
      body: match[2].trim(),
    });
  }

  return blocks;
}

export function getPropertyValue(body: string, prop: string): string | null {
  const escapedProp = escapeRegex(prop);
  const regex = new RegExp(`(?:^|;|\\s)${escapedProp}\\s*:\\s*([^;}]+)`, 'i');
  const match = regex.exec(body);
  return match ? match[1].trim() : null;
}

export function parseAbsoluteLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^([\d.]+)px$/.exec(value.trim());
  if (match) {
    const num = parseFloat(match[1]);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

export function stripKeyframesBlocks(cssText: string): string {
  return cssText.replace(
    /@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g,
    '',
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
