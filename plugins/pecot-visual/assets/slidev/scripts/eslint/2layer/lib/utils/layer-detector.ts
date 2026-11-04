import path from 'path';

interface LayerDef {
  id: number;
  name: string;
  pattern: RegExp;
}

export const LAYERS: { LAYOUTS: LayerDef; COMPONENTS: LayerDef } = {
  LAYOUTS: { id: 1, name: 'Layouts', pattern: /\/layouts\/[^/]+\.[^/]+$/ },
  COMPONENTS: { id: 3, name: 'Components', pattern: /\/components\/(.+\/)?[^/]+\.[^/]+$/ },
};

const ALLOWED_DEPENDENCIES: Record<number, number[]> = {
  [1]: [3],
  [3]: [3],
};

const EXCLUDED_DIRS = ['setup', 'pages', 'styles', 'dist', 'node_modules', 'public', 'utils', 'composables'];

interface LayerInfo {
  id: number;
  name: string;
}

interface LayerDetails extends LayerInfo {
  expectedPath: string;
  allowedExtensions: string[];
  namingPattern: RegExp;
  namingDescription: string;
  maxDepthFromLayerDir: number;
  layerDir: string;
}

export function detectLayer(filePath: string): LayerInfo | null {
  const normalizedPath = path.normalize(filePath);

  for (const layer of Object.values(LAYERS)) {
    if (layer.pattern.test(normalizedPath)) {
      return { id: layer.id, name: layer.name };
    }
  }

  return null;
}

export function isInExcludedDir(filePath: string): boolean {
  return EXCLUDED_DIRS.some((dir) => filePath.includes('/' + dir + '/'));
}

export function resolveImportPath(importPath: string, currentFilePath: string): string | null {
  if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
    return null;
  }

  const currentDir = path.dirname(currentFilePath);
  const resolvedPath = path.resolve(currentDir, importPath);

  if (!resolvedPath.endsWith('.vue') && !resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.ts')) {
    return resolvedPath + '.vue';
  }

  return resolvedPath;
}

export function isAllowedImport(fromLayerId: number, toLayerId: number): boolean {
  const allowedLayerIds = ALLOWED_DEPENDENCIES[fromLayerId] || [];
  return allowedLayerIds.includes(toLayerId);
}

export function getAllowedLayersDescription(layerId: number): string {
  const allowedLayerIds = ALLOWED_DEPENDENCIES[layerId] || [];

  if (allowedLayerIds.length === 0) {
    return 'none';
  }

  const seen = new Set<number>();
  return allowedLayerIds
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((allowedId) => {
      const layer = Object.values(LAYERS).find((l) => l.id === allowedId);
      return layer ? `Layer ${layer.id} (${layer.name})` : `Layer ${allowedId}`;
    })
    .join(', ');
}

function getDepthFromLayerDir(filePath: string, layerDir: string): number {
  const marker = '/' + layerDir + '/';
  const idx = filePath.lastIndexOf(marker);
  if (idx === -1) return 0;
  const after = filePath.substring(idx + marker.length);
  return after.split('/').length;
}

export function detectLayerWithDetails(filePath: string): LayerDetails | null {
  const normalizedPath = path.normalize(filePath);

  if (LAYERS.LAYOUTS.pattern.test(normalizedPath)) {
    return {
      id: LAYERS.LAYOUTS.id,
      name: LAYERS.LAYOUTS.name,
      expectedPath: 'layouts/*.vue',
      allowedExtensions: ['.vue'],
      namingPattern: /^(_tpl-[a-z0-9]+(-[a-z0-9]+)*|[a-z][a-z0-9]*(-[a-z0-9]+)*)\.vue$/,
      namingDescription: 'kebab-case (e.g., content.vue, media-right-image.vue, _tpl-content.vue)',
      maxDepthFromLayerDir: 1,
      layerDir: 'layouts',
    };
  }

  if (LAYERS.COMPONENTS.pattern.test(normalizedPath)) {
    return {
      id: LAYERS.COMPONENTS.id,
      name: LAYERS.COMPONENTS.name,
      expectedPath: 'components/**/*.vue',
      allowedExtensions: ['.vue'],
      namingPattern: /^[A-Z][A-Za-z0-9]*\.vue$/,
      namingDescription: 'PascalCase (e.g., SHeader.vue, LDescriptionText.vue)',
      maxDepthFromLayerDir: 3,
      layerDir: 'components',
    };
  }

  return null;
}

export { getDepthFromLayerDir };
