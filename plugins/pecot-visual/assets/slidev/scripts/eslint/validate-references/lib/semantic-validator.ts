import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';

import {
  resolveFieldValues,
  validateText,
  parseFrontmatter,
  hasBoldEmphasis,
  BOLD_REQUIRED_MESSAGE,
  getLayoutPropTree,
  collectMatchingLengthDeclarations,
} from '@v-slidev/eslint-shared';
import type { FrontmatterBase, TextConstraint, PropSchemaNode } from '@v-slidev/eslint-shared';

export interface SemanticError {
  rule: string;
  message: string;
}

interface ReferenceData {
  description?: string;
  layout?: string;
  status?: string;
  category?: string;
  layout_categories?: unknown;
  text_constraints?: Record<string, unknown>;
  includes?: string[];
  props?: Record<string, unknown>;
  examples?: Array<{ name?: string; frontmatter?: string }>;
}

export function validateSemantics(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];

  // 語彙（layout_categories）そのものの確認は、_common.yaml 1 ファイルの検証としてだけ実行する。
  // レイアウト側から参照すると、同じ違反がレイアウト件数分重複する。
  // _common.yaml 自身の行には 0 件と出る（出力が膨らんで hook の切り詰めで編集ファイルの行が落ちる）。
  if (basename(filePath) === '_common.yaml') {
    errors.push(...checkCategoryVocabulary(data));
  }

  if (!data.layout) {
    return errors;
  }

  errors.push(...checkTextConstraints(data));
  errors.push(...checkTextConstraintKeys(data));
  errors.push(...checkCategoryKnown(data, filePath));
  errors.push(...checkIncludesExist(data, filePath));
  errors.push(...checkIncludesPropsCollision(data, filePath));
  errors.push(...checkSameLengthAsTargets(data, filePath));
  errors.push(...checkLayoutFilenameMatch(data, filePath));
  errors.push(...checkExamplesTextViolations(data));
  errors.push(...checkSlideFilesTextViolations(data, filePath));
  errors.push(...checkGanttchartMaxTasks(data));
  errors.push(...checkSlideFilesGanttchartMaxTasks(data, filePath));

  return errors;
}

function checkTextConstraints(data: ReferenceData): SemanticError[] {
  const errors: SemanticError[] = [];
  const constraints = data.text_constraints;
  if (!constraints || typeof constraints !== 'object') {
    return errors;
  }

  for (const [field, constraintRaw] of Object.entries(constraints)) {
    if (!constraintRaw || typeof constraintRaw !== 'object') continue;
    const constraint = constraintRaw as {
      min_chars?: unknown;
      max_chars?: unknown;
      min_items?: unknown;
      max_items?: unknown;
    };

    const minChars = constraint.min_chars;
    const maxChars = constraint.max_chars;

    if (typeof minChars === 'number' && typeof maxChars === 'number' && minChars > maxChars) {
      errors.push({
        rule: 'text-constraints/min-max',
        message: `${field}: min_chars (${minChars}) > max_chars (${maxChars})`,
      });
    }

    const minItems = constraint.min_items;
    const maxItems = constraint.max_items;

    if (typeof minItems === 'number' && typeof maxItems === 'number' && minItems > maxItems) {
      errors.push({
        rule: 'text-constraints/min-max',
        message: `${field}: min_items (${minItems}) > max_items (${maxItems})`,
      });
    }
  }

  return errors;
}

const ALLOWED_CONSTRAINT_KEYS = new Set([
  'min_chars',
  'max_chars',
  'min_items',
  'max_items',
  'bold_required',
  'note',
]);

function checkTextConstraintKeys(data: ReferenceData): SemanticError[] {
  const errors: SemanticError[] = [];
  const constraints = data.text_constraints;
  if (!constraints || typeof constraints !== 'object') {
    return errors;
  }

  for (const [field, constraintRaw] of Object.entries(constraints)) {
    if (!constraintRaw || typeof constraintRaw !== 'object') continue;
    const constraint = constraintRaw as Record<string, unknown>;

    for (const key of Object.keys(constraint)) {
      if (!ALLOWED_CONSTRAINT_KEYS.has(key)) {
        errors.push({
          rule: 'text-constraints/allowed-keys',
          message: `${field}: 許可されていないキー "${key}" が含まれています（許可: ${[...ALLOWED_CONSTRAINT_KEYS].join(', ')}）`,
        });
      }
    }
  }

  return errors;
}

// テンプレート未同期の talk-dir で分類違反が出たときの復旧導線。分類まわりの
// 違反は「語彙を覚え違えた」より「テンプレートが古い」ほうが多いため必ず添える。
const CATEGORY_SYNC_HINT = '（`slide_sync` でテンプレートを同期すると解消します）';

/**
 * `_common.yaml` が宣言する見せ方の分類語彙そのものを確認する。
 * `_common.yaml` の検証としてだけ呼ぶ規則で、レイアウト側からは呼ばない。
 *
 * 確認するのは語彙の内部整合だけ（id 重複）。yaml として読めない場合は loader の parse
 * 層が理由込みで報告するため、ここには来ない。
 */
function checkCategoryVocabulary(data: ReferenceData): SemanticError[] {
  const declared = data.layout_categories;

  if (!Array.isArray(declared)) {
    return [
      {
        rule: 'category/known',
        message: `_common.yaml に layout_categories が定義されていません${CATEGORY_SYNC_HINT}`,
      },
    ];
  }

  const errors: SemanticError[] = [];
  const ids = collectCategoryIds(declared);

  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  for (const id of duplicated) {
    errors.push({
      rule: 'category/known',
      message: `_common.yaml の layout_categories に id "${id}" が重複しています`,
    });
  }

  return errors;
}

/**
 * layout の `category` が隣接 `_common.yaml` の `layout_categories[].id` に
 * 含まれるかを確認する。語彙の定義は yaml 側にだけあるので、既知 id をコード側に持たない。
 *
 * 語彙そのものの異常（`_common.yaml` を読めない・`layout_categories` が無い）は
 * ここでは 1 件も報告しない。レイアウト件数分重複するため、`_common.yaml` 自身の
 * 検証（`checkCategoryVocabulary`）と loader の parse 層が引き受ける。
 * `category` 自体の欠落は schema 層（required）が報告するのでここでは重ねない。
 */
function checkCategoryKnown(data: ReferenceData, filePath: string): SemanticError[] {
  // hidden は catalog に載らず category を持たない。語彙も引かない。
  if (data.category === undefined) return [];

  const ids = readCategoryIds(join(filePath, '..', '_common.yaml'));
  if (ids === undefined) return [];

  if (ids.includes(data.category)) return [];

  return [
    {
      rule: 'category/known',
      message:
        `category "${data.category}" が _common.yaml の layout_categories にありません` +
        `（定義済み: ${ids.join(', ')}）${CATEGORY_SYNC_HINT}`,
    },
  ];
}

/**
 * 隣接 `_common.yaml` から分類 id を読む。読めない / 語彙が無い場合は `undefined` を返し、
 * 呼び出し側を沈黙させる（報告は `_common.yaml` 自身の検証が担う）。
 */
function readCategoryIds(commonPath: string): string[] | undefined {
  let common: { layout_categories?: unknown } | undefined;
  try {
    common = yaml.load(readFileSync(commonPath, 'utf-8')) as { layout_categories?: unknown };
  } catch {
    return undefined;
  }

  const declared = common?.layout_categories;
  if (!Array.isArray(declared)) return undefined;

  return collectCategoryIds(declared);
}

function collectCategoryIds(declared: unknown[]): string[] {
  return declared
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

function checkIncludesExist(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!Array.isArray(data.includes)) return errors;

  const dir = join(filePath, '..');

  for (const name of data.includes) {
    const targetPath = join(dir, `${name}.yaml`);
    if (!existsSync(targetPath)) {
      errors.push({
        rule: 'includes/file-exists',
        message: `includes "${name}" → ${name}.yaml が見つかりません`,
      });
    }
  }

  return errors;
}

function checkIncludesPropsCollision(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!data.props || typeof data.props !== 'object') return errors;
  if (!Array.isArray(data.includes)) return errors;

  const dir = join(filePath, '..');
  const layoutPropKeys = new Set(Object.keys(data.props));

  for (const name of data.includes) {
    const targetPath = join(dir, `${name}.yaml`);
    let shared: { props?: Record<string, unknown> } | undefined;
    try {
      const content = readFileSync(targetPath, 'utf-8');
      shared = yaml.load(content) as { props?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (!shared?.props || typeof shared.props !== 'object') continue;

    for (const key of Object.keys(shared.props)) {
      if (layoutPropKeys.has(key)) {
        errors.push({
          rule: 'includes/props-collision',
          message: `prop "${key}" がレイアウトとincludes先 "${name}" で重複しています`,
        });
      }
    }
  }

  return errors;
}

/**
 * `same_length_as` の宣言値が、このレイアウト（includes 先を含む）の既知 prop の
 * ドット区切りパスを指しているかを確認する。存在しないパスを指した誤字を検出する。
 */
function checkSameLengthAsTargets(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!data.props || typeof data.props !== 'object') return errors;

  const dir = join(filePath, '..');
  const tree = getLayoutPropTree(data as unknown as Record<string, unknown>, [dir]);
  const declarations = collectMatchingLengthDeclarations(tree);

  for (const declaration of declarations) {
    if (resolvePropPath(tree, declaration.target)) continue;

    errors.push({
      rule: 'same-length-as/target-exists',
      message: `${declaration.path} の same_length_as が指す "${declaration.target}" という prop が見つかりません`,
    });
  }

  return errors;
}

function resolvePropPath(
  tree: Record<string, PropSchemaNode>,
  dotPath: string,
): PropSchemaNode | undefined {
  const segments = dotPath.split('.');
  let current: Record<string, PropSchemaNode> | undefined = tree;
  let node: PropSchemaNode | undefined;

  for (const segment of segments) {
    if (!current) return undefined;
    node = current[segment];
    if (!node) return undefined;
    current = node.props;
  }

  return node;
}

function checkTextAgainstConstraints(
  constraints: Record<string, unknown> | undefined,
  frontmatter: Record<string, unknown>,
  source: string,
): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!constraints || typeof constraints !== 'object') return errors;

  for (const [fieldPath, constraintRaw] of Object.entries(constraints)) {
    const constraint = constraintRaw as TextConstraint | null | undefined;
    const resolved = resolveFieldValues(frontmatter, fieldPath);
    const boldRequired = constraint?.bold_required === true;

    for (const { value, path } of resolved) {
      if (typeof value !== 'string' || value.trim() === '') continue;

      const textErrors = validateText(value, constraint);
      for (const err of textErrors) {
        errors.push({
          rule: 'text-constraints/text-violation',
          message: `${source} ${path || fieldPath}: ${err.message}`,
        });
      }

      if (boldRequired && !hasBoldEmphasis(value)) {
        errors.push({
          rule: 'text-constraints/bold-required',
          message: `${source} ${path || fieldPath}: ${BOLD_REQUIRED_MESSAGE}`,
        });
      }
    }
  }

  return errors;
}

function checkExamplesTextViolations(data: ReferenceData): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!Array.isArray(data.examples) || !data.text_constraints) return errors;

  for (let i = 0; i < data.examples.length; i++) {
    const example = data.examples[i];
    if (!example?.frontmatter) continue;

    let fm: Record<string, unknown> | undefined;
    try {
      const raw = example.frontmatter.replace(/^---\n?/, '').replace(/\n---\s*$/, '');
      fm = yaml.load(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!fm || typeof fm !== 'object') continue;

    const label = `examples[${i}]${example.name ? `(${example.name})` : ''}`;
    errors.push(...checkTextAgainstConstraints(data.text_constraints, fm, label));
  }

  return errors;
}

function findPresentationDirs(baseDir: string): string[] {
  const dirs: string[] = [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return dirs;
  }
  if (entries.some((e) => e.isFile() && e.name === 'slides.md')) {
    dirs.push(baseDir);
    return dirs;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(...findPresentationDirs(join(baseDir, entry.name)));
    }
  }
  return dirs;
}

function checkSlideFilesTextViolations(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  if (!data.text_constraints || !data.layout) return errors;

  const refsDir = join(filePath, '..');
  const pagesDir = join(refsDir, '..');

  const scanDirs = [pagesDir];

  const templateRoot = join(pagesDir, '..', '..', '..');
  const presentationsDir = join(templateRoot, '_presentations');
  for (const presDir of findPresentationDirs(presentationsDir)) {
    const presPages = join(presDir, 'pages');
    try {
      readdirSync(presPages);
      scanDirs.push(presPages);
    } catch {
      // no pages dir
    }
  }

  for (const dir of scanDirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const mdPath = join(dir, file);
      let content: string;
      try {
        content = readFileSync(mdPath, 'utf-8');
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content) as FrontmatterBase | null;
      if (!fm || fm.layout !== data.layout) continue;

      const relPath = mdPath.includes('_presentations/')
        ? mdPath.slice(mdPath.indexOf('_presentations/'))
        : file;
      errors.push(...checkTextAgainstConstraints(data.text_constraints, fm, relPath));
    }
  }

  return errors;
}

interface GanttTask {
  children?: GanttTask[];
}

function countTaskRows(tasks: GanttTask[]): number {
  let count = 0;
  for (const task of tasks) {
    count += 1;
    if (Array.isArray(task.children)) {
      count += countTaskRows(task.children);
    }
  }
  return count;
}

function checkGanttchartMaxTasks(data: ReferenceData): SemanticError[] {
  const errors: SemanticError[] = [];
  if (data.layout !== 'ganttchart') return errors;
  if (!Array.isArray(data.examples)) return errors;

  for (let i = 0; i < data.examples.length; i++) {
    const example = data.examples[i];
    if (!example?.frontmatter) continue;

    let fm: { chartContent?: { tasks?: GanttTask[] } } | undefined;
    try {
      const raw = example.frontmatter.replace(/^---\n?/, '').replace(/\n---\s*$/, '');
      fm = yaml.load(raw) as { chartContent?: { tasks?: GanttTask[] } };
    } catch {
      continue;
    }
    if (!fm || typeof fm !== 'object') continue;

    const tasks = fm.chartContent?.tasks;
    if (!Array.isArray(tasks)) continue;

    const rowCount = countTaskRows(tasks);
    const maxRows = 11;

    if (rowCount > maxRows) {
      errors.push({
        rule: 'ganttchart/max-tasks',
        message: `examples[${i}]${example.name ? `(${example.name})` : ''}: タスク行数 ${rowCount} が上限 ${maxRows} を超えています`,
      });
    }
  }

  return errors;
}

function checkSlideFilesGanttchartMaxTasks(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  if (data.layout !== 'ganttchart') return errors;

  const refsDir = join(filePath, '..');
  const pagesDir = join(refsDir, '..');

  const scanDirs = [pagesDir];

  const templateRoot = join(pagesDir, '..', '..', '..');
  const presentationsDir = join(templateRoot, '_presentations');
  for (const presDir of findPresentationDirs(presentationsDir)) {
    const presPages = join(presDir, 'pages');
    try {
      readdirSync(presPages);
      scanDirs.push(presPages);
    } catch {
      // no pages dir
    }
  }

  for (const dir of scanDirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const mdPath = join(dir, file);
      let content: string;
      try {
        content = readFileSync(mdPath, 'utf-8');
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content) as (FrontmatterBase & { chartContent?: { tasks?: GanttTask[] } }) | null;
      if (!fm || fm.layout !== data.layout) continue;

      const tasks = fm.chartContent?.tasks;
      if (!Array.isArray(tasks)) continue;

      const rowCount = countTaskRows(tasks);
      const maxRows = 11;

      if (rowCount > maxRows) {
        const relPath = mdPath.includes('_presentations/')
          ? mdPath.slice(mdPath.indexOf('_presentations/'))
          : file;
        errors.push({
          rule: 'ganttchart/max-tasks',
          message: `${relPath}: タスク行数 ${rowCount} が上限 ${maxRows} を超えています`,
        });
      }
    }
  }

  return errors;
}

function checkLayoutFilenameMatch(data: ReferenceData, filePath: string): SemanticError[] {
  const errors: SemanticError[] = [];
  const fileName = basename(filePath, '.yaml');

  if (data.layout !== fileName) {
    errors.push({
      rule: 'layout/filename-match',
      message: `layout "${data.layout}" がファイル名 "${fileName}.yaml" と一致しません`,
    });
  }

  return errors;
}
