import type { PropSchemaNode } from '@v-slidev/eslint-shared';
import { isPlainObject } from '@v-slidev/eslint-shared';

export interface UnknownPropFinding {
  path: string;
  allowed: string[];
  // トップレベル違反 = false、ネスト（object / array 降下後）の違反 = true。
  // report 側の message 振り分けはこのフラグで行う（path 文字列の解析はしない）。
  isNested: boolean;
}

function getOwn<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// 実データの形（object / array / scalar）で降下を決める。宣言 type 文字列
// （'Array<String>' 等の表記ばらつき）には依存しない。
function walkNode(
  value: unknown,
  node: PropSchemaNode,
  path: string,
  findings: UnknownPropFinding[],
): void {
  if (isPlainObject(value)) {
    // props スキーマが無い Object は subtree ごと skip（未知キー検出の対象外）
    if (!node.props) {
      return;
    }
    const propMap = node.props;
    const allowed = Object.keys(propMap);
    for (const key of Object.keys(value)) {
      const childNode = getOwn(propMap, key);
      const childPath = `${path}.${key}`;
      if (!childNode) {
        findings.push({ path: childPath, allowed, isNested: true });
        continue;
      }
      walkNode(value[key], childNode, childPath, findings);
    }
    return;
  }

  if (Array.isArray(value)) {
    // items スキーマが無い Array は skip（スカラー配列・schema 未宣言の配列）
    if (!node.items) {
      return;
    }
    const itemMap = node.items;
    const allowed = Object.keys(itemMap);
    for (let i = 0; i < value.length; i++) {
      const element: unknown = value[i];
      if (!isPlainObject(element)) {
        continue;
      }
      const elementPath = `${path}[${i}]`;
      for (const key of Object.keys(element)) {
        const childNode = getOwn(itemMap, key);
        const childPath = `${elementPath}.${key}`;
        if (!childNode) {
          findings.push({ path: childPath, allowed, isNested: true });
          continue;
        }
        walkNode(element[key], childNode, childPath, findings);
      }
    }
  }
  // scalar / null は何もしない
}

export function collectUnknownProps(
  frontmatter: Record<string, unknown>,
  tree: Record<string, PropSchemaNode>,
  topLevelAllowed: Set<string>,
): UnknownPropFinding[] {
  const findings: UnknownPropFinding[] = [];
  if (!isPlainObject(frontmatter)) {
    return findings;
  }

  const treeKeys = Object.keys(tree);
  for (const key of Object.keys(frontmatter)) {
    if (topLevelAllowed.has(key)) {
      // SLIDEV 標準キーは pass（降下しない）
      continue;
    }
    const node = getOwn(tree, key);
    if (!node) {
      findings.push({ path: key, allowed: treeKeys, isNested: false });
      continue;
    }
    walkNode(frontmatter[key], node, key, findings);
  }

  return findings;
}
