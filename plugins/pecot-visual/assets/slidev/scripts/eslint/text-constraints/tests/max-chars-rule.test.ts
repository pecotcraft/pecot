import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearCache, BOLD_REQUIRED_MESSAGE, EM_DISALLOWED_MESSAGE } from '@v-slidev/eslint-shared';
import maxCharsRule from '../lib/rules/max-chars.ts';

// 実 references ではなく専用 fixture を組む。bold_required 単独宣言や includes 継承など
// 配布 yaml に存在しない組み合わせも検証するため。
let fixtureRoot: string;
let pagesDir: string;

const FIXTURES: Record<string, string> = {
  'tc-bold.yaml': [
    'layout: tc-bold',
    'text_constraints:',
    "  'items[].description':",
    '    min_chars: 1',
    '    max_chars: 30',
    '    bold_required: true',
    "  'note':",
    '    max_chars: 30',
    '',
  ].join('\n'),
  'tc-bold-only.yaml': [
    'layout: tc-bold-only',
    'text_constraints:',
    "  'summary':",
    '    bold_required: true',
    '',
  ].join('\n'),
  'tc-bold-items.yaml': [
    'layout: tc-bold-items',
    'text_constraints:',
    "  'items[]':",
    '    max_items: 2',
    '    bold_required: true',
    '',
  ].join('\n'),
  '_bold-shared.yaml': [
    'text_constraints:',
    "  'sharedText':",
    '    bold_required: true',
    '',
  ].join('\n'),
  'tc-inherit.yaml': [
    'layout: tc-inherit',
    'includes:',
    '  - _bold-shared',
    'text_constraints:',
    "  'title':",
    '    max_chars: 30',
    '',
  ].join('\n'),
  'tc-items-limit.yaml': [
    'layout: tc-items-limit',
    'text_constraints:',
    "  'chatMessages':",
    '    max_items: 2',
    '',
  ].join('\n'),
  'tc-items-min.yaml': [
    'layout: tc-items-min',
    'text_constraints:',
    "  'table.rows':",
    '    min_items: 3',
    '    max_items: 6',
    "    note: '2 行以下は表にしない'",
    '',
  ].join('\n'),
  'tc-items-min-only.yaml': [
    'layout: tc-items-min-only',
    'text_constraints:',
    "  'table.rows':",
    '    min_items: 3',
    '',
  ].join('\n'),
  'tc-items-no-note.yaml': [
    'layout: tc-items-no-note',
    'text_constraints:',
    "  'table.rows':",
    '    min_items: 3',
    '    max_items: 4',
    "  'cols[].x':",
    '    min_items: 2',
    '',
  ].join('\n'),
  'tc-empty.yaml': ['layout: tc-empty', 'text_constraints: {}', ''].join('\n'),
  'tc-min.yaml': [
    'layout: tc-min',
    'text_constraints:',
    "  'summary':",
    '    min_chars: 5',
    '    max_chars: 30',
    '',
  ].join('\n'),
  // ドット区切りの非配列パス（comparison-radar の methodA.details1 と同じ形）
  'tc-dotted.yaml': [
    'layout: tc-dotted',
    'text_constraints:',
    "  'methodA.details1':",
    '    min_chars: 1',
    '    max_chars: 30',
    '    bold_required: true',
    "  'methodA.details2':",
    '    min_chars: 1',
    '    max_chars: 30',
    '',
  ].join('\n'),
  // [] の付かないパス。値が配列で渡ることがある（bulletItems 相当）
  'tc-bare-array.yaml': [
    'layout: tc-bare-array',
    'text_constraints:',
    "  'bulletItems':",
    '    bold_required: true',
    '',
  ].join('\n'),
};

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v-slidev-bold-required-'));
  pagesDir = path.join(fixtureRoot, 'pages');
  const referencesDir = path.join(pagesDir, '_references');
  fs.mkdirSync(referencesDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(referencesDir, name), body, 'utf-8');
  }
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

interface CapturedReport {
  messageId: string;
  data: {
    fieldPath?: string;
    detail?: string;
    actual?: string;
    limit?: string;
    note?: string;
  };
}

function runWithContext(context: Record<string, unknown>): void {
  clearCache();
  const visitors = maxCharsRule.create(context as never) as unknown as {
    Program: (node: unknown) => void;
  };
  visitors.Program({});
}

function runRuleAt(
  frontmatter: string[],
  filename: string,
  referencesDirectories: string[] = [path.join(pagesDir, '_references')],
): CapturedReport[] {
  const text = ['---', ...frontmatter, '---', ''].join('\n');
  const reports: CapturedReport[] = [];
  runWithContext({
    sourceCode: { getText: () => text },
    filename,
    settings: { 'slidev-theme': { referencesDirectories } },
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  });
  return reports;
}

function runRule(frontmatter: string[]): CapturedReport[] {
  return runRuleAt(frontmatter, path.join(pagesDir, 'case.md'));
}

function boldPaths(reports: CapturedReport[]): (string | undefined)[] {
  return reports.filter((r) => r.messageId === 'boldRequired').map((r) => r.data.fieldPath);
}

function emPaths(reports: CapturedReport[]): (string | undefined)[] {
  return reports.filter((r) => r.messageId === 'emDisallowed').map((r) => r.data.fieldPath);
}

test('太字なしの description を boldRequired で報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '太字のない説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('<strong> があれば報告しない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('<b> だけでは太字強調とみなさない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<b>要点</b>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('空の <strong></strong> は太字強調とみなさない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong></strong>要点のない説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('エンティティ化された &lt;strong&gt; は太字強調とみなさない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '&lt;strong&gt;要点&lt;/strong&gt;の説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('属性付きの <strong class="x"> を許容する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    '  - description: \'<strong class="hl">要点</strong>のある説明文\'',
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('大文字の <STRONG> を許容する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<STRONG>要点</STRONG>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('bold_required を宣言していないフィールドは検証しない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>あり'",
    "note: '太字のない注記'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('配列要素ごとに違反箇所を報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '太字なし1つ目'",
    "  - description: '<strong>要点</strong>あり'",
    "  - description: '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description', 'items[2].description']);
});

test('max_chars を伴わない bold_required 単独宣言でも機能する', () => {
  const reports = runRule(['layout: tc-bold-only', "summary: '太字のない要約'"]);
  assert.deepEqual(boldPaths(reports), ['summary']);
  assert.deepEqual(
    boldPaths(runRule(['layout: tc-bold-only', "summary: '<strong>要約</strong>の要点'"])),
    [],
  );
});

test('max_items を併記した制約でもテキスト検証がスキップされない', () => {
  const reports = runRule([
    'layout: tc-bold-items',
    'items:',
    "  - '太字なし1つ目'",
    "  - '<strong>要点</strong>あり'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0]']);
  assert.deepEqual(
    reports.filter((r) => r.messageId === 'maxItems'),
    [],
  );
});

test('max_chars 違反と boldRequired を同時に報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    `  - description: '${'あ'.repeat(31)}'`,
  ]);
  assert.deepEqual(
    reports.map((r) => r.messageId).sort(),
    ['boldRequired', 'maxChars'],
  );
});

test('null / 空文字は emptyText のみを報告し boldRequired と二重報告しない', () => {
  for (const literal of ['null', "''"]) {
    const reports = runRule([
      'layout: tc-bold',
      'items:',
      `  - description: ${literal}`,
    ]);
    assert.deepEqual(
      reports.map((r) => r.messageId),
      ['emptyText'],
      `literal=${literal}`,
    );
  }
});

test('includes 経由で継承した bold_required も適用される', () => {
  const reports = runRule(['layout: tc-inherit', "sharedText: '太字のない共通テキスト'"]);
  assert.deepEqual(boldPaths(reports), ['sharedText']);
});

test('全文を <strong> で囲んだ値は要点強調なしとして報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>全文まるごと太字</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('複数の <strong> で全文を覆った値も報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>前半</strong><strong>後半</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

// F-12: 空白のみの値
test('空白のみの値は emptyText のみを報告する', () => {
  const reports = runRule(['layout: tc-bold', 'items:', "  - description: '   '"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['emptyText'],
  );
});

test('空白のみの値は minChars とも二重報告しない', () => {
  const reports = runRule(['layout: tc-min', "summary: '  '"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['emptyText'],
  );
});

// F-14: ドット区切りの非配列パス
test('ドット区切りの非配列パスで太字なしを報告する', () => {
  const reports = runRule(['layout: tc-dotted', 'methodA:', "  details1: '太字のない要点'"]);
  assert.deepEqual(boldPaths(reports), ['methodA.details1']);
});

test('ドット区切りの非配列パスで <strong> があれば報告しない', () => {
  const reports = runRule([
    'layout: tc-dotted',
    'methodA:',
    "  details1: '運用工数を<strong>80%削減</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('ドット区切りで宣言の無い兄弟フィールドは検証しない', () => {
  const reports = runRule([
    'layout: tc-dotted',
    'methodA:',
    "  details1: '運用工数を<strong>80%削減</strong>'",
    "  details2: '太字のない補足行'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

// F-16: [] の付かないパスに配列が来た場合
test('[] の付かないパスの配列値を要素ごとに検証する', () => {
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '太字なし1つ目'",
    "  - '<strong>要点</strong>のある2つ目'",
    "  - '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['bulletItems[0]', 'bulletItems[2]']);
});

test('[] の付かないパスの配列で非文字列・空白要素は飛ばす', () => {
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '   '",
    '  - 42',
    "  - '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['bulletItems[2]']);
});

test('meta.messages.boldRequired が _shared の文言を使う', () => {
  const meta = maxCharsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.boldRequired.includes(BOLD_REQUIRED_MESSAGE));
  assert.ok(meta.messages.boldRequired.includes('**'));
});

// F-03: <em> は強調記法として不可（強調は <strong> のみ）
test('meta.messages.emDisallowed が _shared の文言を使う', () => {
  const meta = maxCharsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.emDisallowed.includes(EM_DISALLOWED_MESSAGE));
});

test('<em> を含む description を emDisallowed で報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>は<em>ここ</em>です'",
  ]);
  assert.deepEqual(emPaths(reports), ['items[0].description']);
});

test('属性付き・大文字の <EM class="x"> も報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    '  - description: \'<strong>要点</strong>は<EM class="x">ここ</EM>です\'',
  ]);
  assert.deepEqual(emPaths(reports), ['items[0].description']);
});

test('bold_required を伴わないフィールドでも <em> を報告する', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
    "note: '<em>強調</em>のある注記'",
  ]);
  assert.deepEqual(emPaths(reports), ['note']);
});

test('<em> がなければ emDisallowed を報告しない', () => {
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
  ]);
  assert.deepEqual(emPaths(reports), []);
});

test('[] の付かないパスの配列値も要素ごとに <em> を検出する', () => {
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '<strong>要点</strong>のある1つ目'",
    "  - '<em>強調</em>のある2つ目'",
  ]);
  assert.deepEqual(emPaths(reports), ['bulletItems[1]']);
});

// 制約解決までのガード分岐（bold_required の追加で変えてはいけない既存挙動）

test('sourceCode.getText が投げたら何も報告しない', () => {
  const reports: CapturedReport[] = [];
  runWithContext({
    sourceCode: {
      getText: () => {
        throw new Error('no source');
      },
    },
    filename: path.join(pagesDir, 'case.md'),
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  });
  assert.deepEqual(reports, []);
});

test('layout の無い frontmatter は検証しない', () => {
  assert.deepEqual(runRule(["summary: '太字のない要約'"]), []);
});

test('references の場所が settings に無ければ検証しない', () => {
  const page = path.join(pagesDir, 'case.md');
  assert.deepEqual(runRuleAt(['layout: tc-bold-only', "summary: '太字なし'"], page, []), []);
});

test('references の場所は settings の先頭から探し、先のディレクトリが勝つ', () => {
  const talkReferences = path.join(fixtureRoot, 'talk', 'references');
  fs.mkdirSync(talkReferences, { recursive: true });
  fs.writeFileSync(
    path.join(talkReferences, 'tc-bold-only.yaml'),
    ['layout: tc-bold-only', 'text_constraints:', "  'summary':", '    max_chars: 3', ''].join('\n'),
    'utf-8',
  );
  const page = path.join(pagesDir, 'case.md');
  const themeReferences = path.join(pagesDir, '_references');
  const frontmatter = ['layout: tc-bold-only', "summary: '四文字以上の要約'"];
  const talkFirst = runRuleAt(frontmatter, page, [talkReferences, themeReferences]);
  assert.deepEqual(
    talkFirst.map((r) => r.messageId),
    ['maxChars'],
  );
  const themeFirst = runRuleAt(frontmatter, page, [themeReferences, talkReferences]);
  assert.deepEqual(
    themeFirst.map((r) => r.messageId),
    ['boldRequired'],
  );
});

test('reference yaml の無い layout は検証しない', () => {
  assert.deepEqual(runRule(['layout: tc-missing', "summary: '太字なし'"]), []);
});

test('text_constraints が空の reference は検証しない', () => {
  assert.deepEqual(runRule(['layout: tc-empty', "summary: '太字なし'"]), []);
});

test('frontmatter に存在しないフィールドは報告しない', () => {
  assert.deepEqual(runRule(['layout: tc-bold-only', "title: 'サマリ未設定'"]), []);
});

test('文字列でない値は検証しない', () => {
  assert.deepEqual(runRule(['layout: tc-bold-only', 'summary:', '  nested: 1']), []);
});

test('max_items 超過を maxItems で報告する（要素に違反がなければ他は報告しない）', () => {
  const reports = runRule([
    'layout: tc-items-limit',
    'chatMessages:',
    "  - 'a'",
    "  - 'b'",
    "  - 'c'",
  ]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['maxItems'],
  );
});

function tableRows(count: number): string[] {
  return [
    'layout: tc-items-min',
    'table:',
    '  rows:',
    ...Array.from({ length: count }, (_, i) => `    - label: '行${i + 1}'`),
  ];
}

function itemReports(reports: CapturedReport[]): CapturedReport[] {
  return reports.filter((r) => r.messageId === 'minItems' || r.messageId === 'maxItems');
}

function formatMessage(report: CapturedReport): string {
  const meta = maxCharsRule.meta as { messages: Record<string, string> };
  let text = meta.messages[report.messageId];
  for (const [key, value] of Object.entries(report.data)) {
    text = text.replaceAll(`{{${key}}}`, String(value));
  }
  return text;
}

test('min_items 未満を minItems で報告し note を添える', () => {
  const reports = runRule(tableRows(1));
  assert.deepEqual(
    reports.map((r) => ({ messageId: r.messageId, ...r.data })),
    [
      {
        messageId: 'minItems',
        fieldPath: 'table.rows',
        actual: '1',
        limit: '3',
        note: '。2 行以下は表にしない',
      },
    ],
  );
  assert.equal(
    formatMessage(reports[0]),
    'table.rows: 配列要素数が1です（最小3）。2 行以下は表にしない',
  );
});

test('min_items ちょうどの配列は報告しない', () => {
  assert.deepEqual(itemReports(runRule(tableRows(3))), []);
});

test('min_items の境界: 下限 - 1 の 2 件は報告し、空配列 0 件も報告する', () => {
  const two = itemReports(runRule(tableRows(2)));
  assert.deepEqual(
    two.map((r) => [r.messageId, r.data.actual, r.data.limit]),
    [['minItems', '2', '3']],
  );
  const zero = itemReports(runRule(['layout: tc-items-min', 'table:', '  rows: []']));
  assert.deepEqual(
    zero.map((r) => [r.messageId, r.data.actual, r.data.limit]),
    [['minItems', '0', '3']],
  );
});

test('max_items 超過の maxItems にも note を添える', () => {
  const reports = itemReports(runRule(tableRows(7)));
  assert.deepEqual(
    reports.map((r) => ({ messageId: r.messageId, ...r.data })),
    [
      {
        messageId: 'maxItems',
        fieldPath: 'table.rows',
        actual: '7',
        limit: '6',
        note: '。2 行以下は表にしない',
      },
    ],
  );
  assert.equal(
    formatMessage(reports[0]),
    'table.rows: 配列要素数が7です（最大6）。2 行以下は表にしない',
  );
});

test('note が無い制約は句点も付けずに終わる', () => {
  const rows = (n: number) => [
    'layout: tc-items-no-note',
    'table:',
    '  rows:',
    ...Array.from({ length: n }, (_, i) => `    - '行${i + 1}'`),
  ];
  const low = itemReports(runRule(rows(2)));
  assert.equal(low.length, 1);
  assert.equal(low[0].data.note, '');
  assert.equal(formatMessage(low[0]), 'table.rows: 配列要素数が2です（最小3）');
  const high = itemReports(runRule(rows(5)));
  assert.equal(formatMessage(high[0]), 'table.rows: 配列要素数が5です（最大4）');
});

test('min_items だけを宣言した制約は上限判定をしない', () => {
  const rows = (n: number) => [
    'layout: tc-items-min-only',
    'table:',
    '  rows:',
    ...Array.from({ length: n }, (_, i) => `    - '行${i + 1}'`),
  ];
  assert.deepEqual(itemReports(runRule(rows(50))), []);
  assert.deepEqual(
    itemReports(runRule(rows(1))).map((r) => r.messageId),
    ['minItems'],
  );
});

test('配列でない値には件数判定をしない', () => {
  assert.deepEqual(
    itemReports(runRule(['layout: tc-items-min', 'table:', "  rows: '文字列'"])),
    [],
  );
});

test('min_items を持つフィールドがページに無ければ 0 件として報告する', () => {
  const reports = itemReports(runRule(['layout: tc-items-min', "title: 'x'"]));
  assert.deepEqual(
    reports.map((r) => [r.messageId, r.data.fieldPath, r.data.actual]),
    [['minItems', 'table.rows', '0']],
  );
});

test('[] を含むパスで要素が無い場合は件数を報告しない', () => {
  const reports = itemReports(
    runRule(['layout: tc-items-no-note', 'table:', "  rows: ['a','b','c']", 'cols: []']),
  );
  assert.deepEqual(reports, []);
});

// fixture deck の実 reference（axis-table.yaml）を読む
test('fixture deck の axis-table.yaml: 行 2 件・列 1 件で rows / columns の minItems を報告する', () => {
  const realPage = path.resolve(
    import.meta.dirname,
    '../../_shared/tests/fixtures/deck/pages/axis-table-case.md',
  );
  const reports = itemReports(
    runRuleAt(
      [
        'layout: axis-table',
        'tableContent:',
        '  columns:',
        "    - { header: 'A' }",
        '  rows:',
        "    - { label: '1' }",
        "    - { label: '2' }",
      ],
      realPage,
      [path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references')],
    ),
  );
  assert.deepEqual(
    reports.map((r) => [r.messageId, r.data.fieldPath, r.data.actual]).sort(),
    [
      ['minItems', 'tableContent.columns', '1'],
      ['minItems', 'tableContent.rows', '2'],
    ],
  );
});

test('fixture deck の axis-table.yaml: 行 3 件・列 2 件なら件数違反を報告しない', () => {
  const realPage = path.resolve(
    import.meta.dirname,
    '../../_shared/tests/fixtures/deck/pages/axis-table-case.md',
  );
  const reports = itemReports(
    runRuleAt(
      [
        'layout: axis-table',
        'tableContent:',
        '  columns:',
        "    - { header: 'A' }",
        "    - { header: 'B' }",
        '  rows:',
        "    - { label: '1' }",
        "    - { label: '2' }",
        "    - { label: '3' }",
      ],
      realPage,
      [path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references')],
    ),
  );
  assert.deepEqual(reports, []);
});

test('max_items のみの制約でも要素ごとに <em> を検出する', () => {
  const reports = runRule([
    'layout: tc-items-limit',
    'chatMessages:',
    "  - 'a'",
    "  - '<em>b</em>'",
  ]);
  assert.deepEqual(
    reports.map((r) => ({ messageId: r.messageId, fieldPath: r.data.fieldPath })),
    [{ messageId: 'emDisallowed', fieldPath: 'chatMessages[1]' }],
  );
});

test('min_chars 違反を minChars で報告する', () => {
  const reports = runRule(['layout: tc-min', "summary: 'あい'"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['minChars'],
  );
});

// テーマの宣言（layouts.references）が値の出どころであることを、テスト用テーマの references で固定する
test('テーマが宣言した references の text_constraints で文字数を報告する', () => {
  const fixtureReferences = path.resolve(
    import.meta.dirname,
    '../../../../../../cli/tests/fixtures/themes/with-declaration/references',
  );
  const page = path.join(pagesDir, 'case.md');
  const reports = runRuleAt(
    ['layout: panel', "heading: 'あ'", "caption: '四十文字を超える説明文はテーマの宣言した上限で報告されます。四十文字を超える説明文は報告されます。'"],
    page,
    [fixtureReferences],
  );
  assert.deepEqual(
    reports.map((r) => [r.messageId, r.data.fieldPath]),
    [
      ['minChars', 'heading'],
      ['maxChars', 'caption'],
    ],
  );
});
