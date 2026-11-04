import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const referenceCache = new Map<string, Record<string, unknown> | null>();

function loadReferenceFile(filePath: string): Record<string, unknown> | null {
  if (referenceCache.has(filePath)) {
    return referenceCache.get(filePath) ?? null;
  }

  try {
    if (!fs.existsSync(filePath)) {
      referenceCache.set(filePath, null);
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
      referenceCache.set(filePath, null);
      return null;
    }
    referenceCache.set(filePath, parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  } catch {
    referenceCache.set(filePath, null);
    return null;
  }
}

/**
 * directories を先頭から順に探し、`<name>.yaml` が最初に見つかったものを返す。
 * 先に置いたディレクトリが勝つ（talk-dir 側を先に渡すと、テーマ側を上書きできる）。
 */
export function loadLayoutReference(
  directories: readonly string[],
  layoutName: string,
): Record<string, unknown> | null {
  for (const directory of directories) {
    const reference = loadReferenceFile(path.join(directory, `${layoutName}.yaml`));
    if (reference) {
      return reference;
    }
  }
  return null;
}

export interface ClicksValidationConfig {
  type: string;
  source_prop?: string;
  per_page?: number;
  offset?: number;
  min_clicks?: number;
  scroll_prop?: string;
}

export function getClicksValidation(
  reference: Record<string, unknown> | null | undefined,
): ClicksValidationConfig | null {
  const clicks = reference?.clicks as { validation?: unknown } | undefined;
  const validation = clicks?.validation as ClicksValidationConfig | undefined;
  if (!validation || typeof validation !== 'object') {
    return null;
  }
  if (!validation.type) {
    return null;
  }
  if (validation.type !== 'required' && !validation.source_prop) {
    return null;
  }
  if (validation.type === 'pagination' && !validation.per_page) {
    return null;
  }
  return validation;
}

export interface PropSchemaNode {
  type?: string;
  props?: Record<string, PropSchemaNode>;
  items?: Record<string, PropSchemaNode>;
  // 宣言側の配列 prop から見た「同じ件数・同じ順で対にする」相手のフロントマター
  // ドット区切りパス（例 'statContent.rows'）。宣言は same_length_as で書く。
  sameLengthAs?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// prototype 汚染ガード。素の bracket 代入で __proto__ 等が prototype を
// 書き換えるのを防ぐ。walker 側 getOwn（読み取り時 hasOwnProperty ガード）と対称。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setOwn<T>(map: Record<string, T>, key: string, value: T): void {
  if (DANGEROUS_KEYS.has(key)) {
    return;
  }
  map[key] = value;
}

function toSchemaNode(entry: unknown): PropSchemaNode {
  const node: PropSchemaNode = {};
  if (isPlainObject(entry)) {
    if (typeof entry.type === 'string') {
      node.type = entry.type;
    }
    if (isPlainObject(entry.props)) {
      node.props = buildNodeMap(entry.props);
    }
    if (isPlainObject(entry.items)) {
      node.items = buildNodeMap(entry.items);
    }
    if (typeof entry.same_length_as === 'string' && entry.same_length_as.length > 0) {
      node.sameLengthAs = entry.same_length_as;
    }
  }
  return node;
}

function buildNodeMap(propsObj: Record<string, unknown>): Record<string, PropSchemaNode> {
  const map: Record<string, PropSchemaNode> = {};
  for (const key of Object.keys(propsObj)) {
    setOwn(map, key, toSchemaNode(propsObj[key]));
  }
  return map;
}

export function getLayoutPropTree(
  reference: Record<string, unknown> | null | undefined,
  referencesDirectories: readonly string[] = [],
): Record<string, PropSchemaNode> {
  const tree: Record<string, PropSchemaNode> = {};

  const includes = reference?.includes;
  if (Array.isArray(includes) && referencesDirectories.length > 0) {
    for (const name of includes) {
      if (typeof name !== 'string') {
        continue;
      }
      const shared = loadLayoutReference(referencesDirectories, name);
      const sharedProps = shared?.props;
      if (sharedProps && typeof sharedProps === 'object') {
        const sharedMap = sharedProps as Record<string, unknown>;
        for (const key of Object.keys(sharedMap)) {
          setOwn(tree, key, toSchemaNode(sharedMap[key]));
        }
      }
    }
  }

  const refProps = reference?.props;
  if (refProps && typeof refProps === 'object') {
    const refMap = refProps as Record<string, unknown>;
    for (const key of Object.keys(refMap)) {
      setOwn(tree, key, toSchemaNode(refMap[key]));
    }
  }

  return tree;
}

export function getLayoutProps(
  reference: Record<string, unknown> | null | undefined,
  referencesDirectories: readonly string[] = [],
): string[] {
  return Object.keys(getLayoutPropTree(reference, referencesDirectories));
}

export interface MatchingLengthDeclaration {
  // same_length_as を宣言した配列 prop 自身のドット区切りパス（例 'readout.items'）
  path: string;
  // 対にする相手の配列 prop のドット区切りパス（例 'statContent.rows'）
  target: string;
}

/**
 * prop ツリー（getLayoutPropTree の戻り値）を走査し、same_length_as が宣言された
 * 配列 prop を (自身のパス, 対にする相手のパス) の組として集める。
 * Object 配下（node.props）だけを辿る。配列要素スキーマ（node.items）は辿らない
 * （宣言対象はフロントマター直下から辿れる配列 prop パスであり、配列要素内の
 * フィールド同士を比較する用途ではないため）。
 */
export function collectMatchingLengthDeclarations(
  tree: Record<string, PropSchemaNode>,
): MatchingLengthDeclaration[] {
  const declarations: MatchingLengthDeclaration[] = [];
  walkMatchingLength(tree, '', declarations);
  return declarations;
}

function walkMatchingLength(
  props: Record<string, PropSchemaNode>,
  basePath: string,
  declarations: MatchingLengthDeclaration[],
): void {
  for (const key of Object.keys(props)) {
    const node = props[key];
    const path = basePath ? `${basePath}.${key}` : key;
    if (node.sameLengthAs) {
      declarations.push({ path, target: node.sameLengthAs });
    }
    if (node.props) {
      walkMatchingLength(node.props, path, declarations);
    }
  }
}

export function clearCache(): void {
  referenceCache.clear();
}
