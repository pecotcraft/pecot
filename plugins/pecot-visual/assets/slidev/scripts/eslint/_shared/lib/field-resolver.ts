export interface FieldSegment {
  type: 'prop' | 'array';
  name: string;
}

export interface ResolvedField {
  value: unknown;
  path: string;
}

export function parseFieldPath(fieldPath: string): FieldSegment[] {
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
    return [];
  }

  const segments: FieldSegment[] = [];
  const parts = fieldPath.split('.');

  for (const part of parts) {
    if (part.endsWith('[]')) {
      const name = part.slice(0, -2);
      if (name.length > 0) {
        segments.push({ type: 'prop', name });
      }
      segments.push({ type: 'array', name: '' });
    } else {
      segments.push({ type: 'prop', name: part });
    }
  }

  return segments;
}

export function resolveFieldValues(
  frontmatter: Record<string, unknown>,
  fieldPath: string,
): ResolvedField[] {
  const segments = parseFieldPath(fieldPath);
  if (segments.length === 0) {
    return [];
  }

  return resolve([{ value: frontmatter, path: '' }], segments, 0);
}

function resolve(
  current: ResolvedField[],
  segments: FieldSegment[],
  index: number,
): ResolvedField[] {
  if (index >= segments.length) {
    return current;
  }

  const segment = segments[index];
  const next: ResolvedField[] = [];

  for (const entry of current) {
    if (segment.type === 'prop') {
      if (entry.value != null && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
        const obj = entry.value as Record<string, unknown>;
        if (segment.name in obj) {
          const newPath = entry.path ? `${entry.path}.${segment.name}` : segment.name;
          next.push({ value: obj[segment.name], path: newPath });
        }
      }
    } else if (segment.type === 'array') {
      if (Array.isArray(entry.value)) {
        for (let i = 0; i < entry.value.length; i++) {
          const newPath = `${entry.path}[${i}]`;
          next.push({ value: entry.value[i], path: newPath });
        }
      }
    }
  }

  return resolve(next, segments, index + 1);
}
