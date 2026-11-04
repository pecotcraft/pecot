interface ContainerProperties {
  position?: string;
  top?: string;
  left?: string;
  width?: string;
  height?: string;
}

interface ContainerStyle {
  className: string;
  properties: ContainerProperties;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function parseContainerStyles(cssText: string): ContainerStyle[] {
  const containers: ContainerStyle[] = [];

  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

  const containerRegex = /\.([\w-]*container[\w-]*)\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = containerRegex.exec(cleanCss)) !== null) {
    const className = match[1];
    const rulesText = match[2];

    const properties = parseProperties(rulesText);

    containers.push({
      className,
      properties,
    });
  }

  return containers;
}

function parseProperties(rulesText: string): ContainerProperties {
  const properties: ContainerProperties = {};

  const propRegex = /(position|top|left|width|height)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(rulesText)) !== null) {
    const propName = match[1] as keyof ContainerProperties;
    const propValue = match[2].trim();

    properties[propName] = propValue;
  }

  return properties;
}

export function parsePxValue(value: string | undefined | null): number | null {
  if (!value) return null;

  if (value.trim() === '0') return 0;

  const match = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (!match) return null;

  return parseFloat(match[1]);
}

export function extractCoordinates(properties: ContainerProperties): Rect | null {
  const x = parsePxValue(properties.left);
  const y = parsePxValue(properties.top);
  const w = parsePxValue(properties.width);
  const h = parsePxValue(properties.height);

  if (x !== null && y !== null && w !== null && h !== null) {
    return { x, y, w, h };
  }

  return null;
}

export function isOverlapping(rect1: Rect, rect2: Rect): boolean {
  if (rect1.x >= rect2.x + rect2.w) return false;
  if (rect1.x + rect1.w <= rect2.x) return false;
  if (rect1.y >= rect2.y + rect2.h) return false;
  if (rect1.y + rect1.h <= rect2.y) return false;

  return true;
}
