import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearCache, BOLD_REQUIRED_MESSAGE, EM_DISALLOWED_MESSAGE } from '@v-slidev/eslint-shared';
import maxCharsRule from '../lib/rules/max-chars.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v-slidev-bold-required-'));
  pagesDir = path.join(fixtureRoot, 'pages');
  const referencesDir = path.join(pagesDir, '_references');
  fs.mkdirSync(referencesDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(referencesDir, name), body, 'utf-8');
  }
});

afterAll(() => {
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

test('太字の無い description があると、boldRequired を報告する', async () => {
  await explains('`bold_required` を宣言したフィールドの、太字の検証のテストです。値に太字（`<strong>`）が含まれない場合に、`boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '太字のない説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('<strong> があると、報告しない', async () => {
  await explains('`bold_required` を宣言したフィールドの、太字の検証のテストです。値に `<strong>要点</strong>` のような太字が含まれる場合に、何も報告しないことを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('<b> だけだと、太字の強調とみなさず報告する', async () => {
  await explains('太字として認める記法のテストです。`<b>` だけを使った値の場合に、太字とみなさず `boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<b>要点</b>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('<strong></strong> の中身が空だと、太字の強調とみなさず報告する', async () => {
  await explains('太字として認める記法のテストです。`<strong></strong>` の中身が空の場合に、太字とみなさず `boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong></strong>要点のない説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('&lt;strong&gt; のようにエンティティになっていると、太字の強調とみなさず報告する', async () => {
  await explains('太字として認める記法のテストです。`&lt;strong&gt;` のようにエンティティで書かれた値の場合に、太字とみなさず `boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '&lt;strong&gt;要点&lt;/strong&gt;の説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('<strong class="x"> のように属性が付いていても、太字の強調とみなして報告しない', async () => {
  await explains('太字として認める記法のテストです。`<strong class="hl">` のように属性が付いた場合でも、太字とみなして報告しないことを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    '  - description: \'<strong class="hl">要点</strong>のある説明文\'',
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('<STRONG> のように大文字だと、太字の強調とみなして報告しない', async () => {
  await explains('太字として認める記法のテストです。`<STRONG>` のように大文字で書かれた場合でも、太字とみなして報告しないことを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<STRONG>要点</STRONG>のある説明文'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('bold_required を宣言していないフィールドだと、太字の検証をしない', async () => {
  await explains('`bold_required` を宣言していないフィールドのテストです。太字が含まれない値でも、太字の検証をしないことを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>あり'",
    "note: '太字のない注記'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('配列の要素に太字の無いものが複数あると、要素ごとに報告する', async () => {
  await explains('配列の要素ごとの太字の検証のテストです。太字を含まない要素が複数ある場合に、該当する要素ごとに位置を示して報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '太字なし1つ目'",
    "  - description: '<strong>要点</strong>あり'",
    "  - description: '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description', 'items[2].description']);
});

test('max_chars を伴わず bold_required だけを宣言していても、太字の検証をする', async () => {
  await explains('`max_chars` を伴わず `bold_required` だけを宣言した制約のテストです。太字が含まれない値は報告し、含まれる値は報告しないことを確認します。');
  const reports = runRule(['layout: tc-bold-only', "summary: '太字のない要約'"]);
  assert.deepEqual(boldPaths(reports), ['summary']);
  assert.deepEqual(
    boldPaths(runRule(['layout: tc-bold-only', "summary: '<strong>要約</strong>の要点'"])),
    [],
  );
});

test('max_items を併記した制約でも、要素の太字を検証する', async () => {
  await explains('`max_items` と `bold_required` を併記した制約のテストです。太字を含まない要素だけを `boldRequired` として報告し、`maxItems` は報告しないことを確認します。');
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

test('文字数の超過と太字の欠けが重なると、maxChars と boldRequired を同時に報告する', async () => {
  await explains('文字数の超過と太字の欠落が重なった場合のテストです。上限を超え、かつ太字を含まない値に対して、`maxChars` と `boldRequired` を同時に報告することを確認します。');
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

test('値が null か空文字だと、emptyText だけを報告し、boldRequired を重ねて報告しない', async () => {
  await explains('値が空の場合のテストです。値が `null` または空文字のときに、`emptyText` だけを報告し、`boldRequired` は重ねて報告しないことを確認します。');
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

test('includes で継承した bold_required があると、継承したフィールドにも適用する', async () => {
  await explains('`includes` による制約の継承のテストです。継承元で宣言された `bold_required` が、継承したフィールドにも適用されることを確認します。');
  const reports = runRule(['layout: tc-inherit', "sharedText: '太字のない共通テキスト'"]);
  assert.deepEqual(boldPaths(reports), ['sharedText']);
});

test('全文を <strong> で囲んだ値だと、要点の強調が無いとして報告する', async () => {
  await explains('太字が要点を示しているかどうかのテストです。値の全文を `<strong>` で囲んでいる場合に、要点の強調がないものとして `boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>全文まるごと太字</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

test('複数の <strong> で全文を覆った値だと、報告する', async () => {
  await explains('複数の `<strong>` で値の全文を覆った場合のテストです。全文が太字になっているため、`boldRequired` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>前半</strong><strong>後半</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), ['items[0].description']);
});

// F-12: 空白のみの値
test('値が空白だけだと、emptyText だけを報告する', async () => {
  await explains('空白だけの値の検証のテストです。太字の検証より先に `emptyText` だけを報告し、ほかの違反を重ねて報告しないことを確認します。');
  const reports = runRule(['layout: tc-bold', 'items:', "  - description: '   '"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['emptyText'],
  );
});

test('値が空白だけだと、minChars を重ねて報告しない', async () => {
  await explains('`min_chars` を宣言した制約で、値が空白だけの場合のテストです。`emptyText` だけを報告し、`minChars` は重ねて報告しないことを確認します。');
  const reports = runRule(['layout: tc-min', "summary: '  '"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['emptyText'],
  );
});

// F-14: ドット区切りの非配列パス
test('ドット区切りで配列でないパスの値に太字が無いと、報告する', async () => {
  await explains('ドット区切りで配列を含まないパス（`methodA.details1`）のテストです。値に太字が含まれない場合に、そのパスで `boldRequired` を報告することを確認します。');
  const reports = runRule(['layout: tc-dotted', 'methodA:', "  details1: '太字のない要点'"]);
  assert.deepEqual(boldPaths(reports), ['methodA.details1']);
});

test('ドット区切りで配列でないパスの値に <strong> があると、報告しない', async () => {
  await explains('ドット区切りで配列を含まないパス（`methodA.details1`）のテストです。値が `<strong>` を含む場合に、何も報告しないことを確認します。');
  const reports = runRule([
    'layout: tc-dotted',
    'methodA:',
    "  details1: '運用工数を<strong>80%削減</strong>'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

test('ドット区切りで宣言の無い兄弟のフィールドだと、検証しない', async () => {
  await explains('ドット区切りのパスのテストです。`bold_required` を宣言していない兄弟のフィールドに太字が含まれなくても、検証しないことを確認します。');
  const reports = runRule([
    'layout: tc-dotted',
    'methodA:',
    "  details1: '運用工数を<strong>80%削減</strong>'",
    "  details2: '太字のない補足行'",
  ]);
  assert.deepEqual(boldPaths(reports), []);
});

// F-16: [] の付かないパスに配列が来た場合
test('[] の付かないパスに配列が渡されると、要素ごとに太字を検証する', async () => {
  await explains('`[]` の付かないパスに配列が渡された場合のテストです。要素ごとに太字を検証し、太字を含まない要素の位置を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '太字なし1つ目'",
    "  - '<strong>要点</strong>のある2つ目'",
    "  - '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['bulletItems[0]', 'bulletItems[2]']);
});

test('[] の付かないパスの配列に文字列でない要素や空白の要素があると、その要素を飛ばす', async () => {
  await explains('`[]` の付かないパスに渡された配列のテストです。文字列でない要素や空白だけの要素を検証の対象から除き、残りの要素だけを報告することを確認します。');
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '   '",
    '  - 42',
    "  - '太字なし3つ目'",
  ]);
  assert.deepEqual(boldPaths(reports), ['bulletItems[2]']);
});

test('meta.messages.boldRequired を読むと、_shared の文言を含む', async () => {
  await explains('ルールの `meta.messages.boldRequired` のテストです。`_shared` で定義した文言と、強調記法 `**` の案内が含まれることを確認します。');
  const meta = maxCharsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.boldRequired.includes(BOLD_REQUIRED_MESSAGE));
  assert.ok(meta.messages.boldRequired.includes('**'));
});

// F-03: <em> は強調記法として不可（強調は <strong> のみ）
test('meta.messages.emDisallowed を読むと、_shared の文言を含む', async () => {
  await explains('ルールの `meta.messages.emDisallowed` のテストです。`_shared` で定義した文言が含まれることを確認します。');
  const meta = maxCharsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.emDisallowed.includes(EM_DISALLOWED_MESSAGE));
});

test('description が <em> を含むと、emDisallowed を報告する', async () => {
  await explains('強調に `<em>` を使うことを禁止する検証のテストです。値が `<em>` を含む場合に、`emDisallowed` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>は<em>ここ</em>です'",
  ]);
  assert.deepEqual(emPaths(reports), ['items[0].description']);
});

test('<EM class="x"> のように属性が付いて大文字でも、emDisallowed を報告する', async () => {
  await explains('強調に `<em>` を使うことを禁止する検証のテストです。`<EM class="x">` のように属性が付き大文字で書かれた場合でも、`emDisallowed` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    '  - description: \'<strong>要点</strong>は<EM class="x">ここ</EM>です\'',
  ]);
  assert.deepEqual(emPaths(reports), ['items[0].description']);
});

test('bold_required を伴わないフィールドでも、<em> があると報告する', async () => {
  await explains('`<em>` の検証のテストです。`bold_required` を宣言していないフィールドでも、`<em>` が含まれる場合は `emDisallowed` を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
    "note: '<em>強調</em>のある注記'",
  ]);
  assert.deepEqual(emPaths(reports), ['note']);
});

test('<em> が無いと、emDisallowed を報告しない', async () => {
  await explains('`<em>` の検証のテストです。値が `<em>` を含まない場合に、`emDisallowed` を報告しないことを確認します。');
  const reports = runRule([
    'layout: tc-bold',
    'items:',
    "  - description: '<strong>要点</strong>のある説明文'",
  ]);
  assert.deepEqual(emPaths(reports), []);
});

test('[] の付かないパスに配列が渡されると、要素ごとに <em> を検出する', async () => {
  await explains('`[]` の付かないパスに配列が渡された場合のテストです。要素ごとに `<em>` を検出し、含まれる要素の位置を報告することを確認します。');
  const reports = runRule([
    'layout: tc-bare-array',
    'bulletItems:',
    "  - '<strong>要点</strong>のある1つ目'",
    "  - '<em>強調</em>のある2つ目'",
  ]);
  assert.deepEqual(emPaths(reports), ['bulletItems[1]']);
});

// 制約解決までのガード分岐（bold_required の追加で変えてはいけない既存挙動）

test('sourceCode.getText が例外を投げると、何も報告しない', async () => {
  await explains('制約を解決するまでの前提処理のテストです。ソースの取得（`sourceCode.getText`）が例外を投げた場合に、何も報告しないことを確認します。');
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

test('frontmatter に layout が無いと、検証しない', async () => {
  await explains('frontmatter の `layout` が存在しない場合に、検証せず何も報告しないことを確認します。');
  assert.deepEqual(runRule(["summary: '太字のない要約'"]), []);
});

test('references の場所が settings に無いと、検証しない', async () => {
  await explains('references の場所が settings に指定されていない場合に、検証せず何も報告しないことを確認します。');
  const page = path.join(pagesDir, 'case.md');
  assert.deepEqual(runRuleAt(['layout: tc-bold-only', "summary: '太字なし'"], page, []), []);
});

test('同じ名前の reference が複数のディレクトリにあると、settings の先頭に近いものを使う', async () => {
  await explains('同名の reference を複数のディレクトリに置いた場合のテストです。settings で先頭に近いディレクトリのものを使い、並びを入れ替えると結果も入れ替わることを確認します。');
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

test('layout に対応する reference yaml が無いと、検証しない', async () => {
  await explains('`layout` に対応する reference の yaml が存在しない場合に、検証せず何も報告しないことを確認します。');
  assert.deepEqual(runRule(['layout: tc-missing', "summary: '太字なし'"]), []);
});

test('reference の text_constraints が空だと、検証しない', async () => {
  await explains('reference の `text_constraints` が空の場合に、検証せず何も報告しないことを確認します。');
  assert.deepEqual(runRule(['layout: tc-empty', "summary: '太字なし'"]), []);
});

test('制約のあるフィールドが frontmatter に無いと、報告しない', async () => {
  await explains('制約を宣言したフィールドが frontmatter にない場合は、何も報告しないことを確認します。');
  assert.deepEqual(runRule(['layout: tc-bold-only', "title: 'サマリ未設定'"]), []);
});

test('値が文字列でないと、検証しない', async () => {
  await explains('値が文字列でない場合（入れ子のオブジェクトなど）に、検証せず何も報告しないことを確認します。');
  assert.deepEqual(runRule(['layout: tc-bold-only', 'summary:', '  nested: 1']), []);
});

test('要素の数が max_items を超えると、要素に違反が無ければ maxItems だけを報告する', async () => {
  await explains('`max_items` の検証のテストです。要素の数が上限を超え、かつ各要素に違反がない場合に、`maxItems` だけを報告することを確認します。');
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

test('要素の数が min_items に満たないと、note を添えて minItems を報告する', async () => {
  await explains('`min_items` の検証のテストです。要素の数が下限未満の場合に、`note` を添えた `minItems` を報告し、メッセージも `note` を含むことを確認します。');
  const reports = runRule(tableRows(1));
  assert.deepEqual(
    reports.map((r) => ({ messageId: r.messageId, ...r.data })),
    [
      {
        messageId: 'minItems',
        fieldPath: 'table.rows',
        actual: '1',
        limit: '3',
        note: '; 2 行以下は表にしない',
      },
    ],
  );
  assert.equal(
    formatMessage(reports[0]),
    'table.rows: 1 array items (min: 3); 2 行以下は表にしない',
  );
});

test('要素の数が min_items ちょうどだと、報告しない', async () => {
  await explains('`min_items` の境界のテストです。要素の数が下限ちょうどの場合に、何も報告しないことを確認します。');
  assert.deepEqual(itemReports(runRule(tableRows(3))), []);
});

test('要素の数が下限より 1 少ない 2 件か、空配列の 0 件だと、minItems を報告する', async () => {
  await explains('`min_items` の境界のテストです。要素の数が下限より 1 少ない場合と、空配列の場合に、どちらも `minItems` を報告することを確認します。');
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

test('要素の数が max_items を超えると、note を添えて maxItems を報告する', async () => {
  await explains('`max_items` の検証のテストです。要素の数が上限を超えた場合に、`note` を添えた `maxItems` を報告することを確認します。');
  const reports = itemReports(runRule(tableRows(7)));
  assert.deepEqual(
    reports.map((r) => ({ messageId: r.messageId, ...r.data })),
    [
      {
        messageId: 'maxItems',
        fieldPath: 'table.rows',
        actual: '7',
        limit: '6',
        note: '; 2 行以下は表にしない',
      },
    ],
  );
  assert.equal(
    formatMessage(reports[0]),
    'table.rows: 7 array items (max: 6); 2 行以下は表にしない',
  );
});

test('note の無い制約で件数が範囲を外れると、note と区切りを付けないメッセージにする', async () => {
  await explains('`note` を持たない制約のテストです。要素の数が範囲を外れた場合に、`note` と区切り文字を付けないメッセージになることを確認します。');
  const rows = (n: number) => [
    'layout: tc-items-no-note',
    'table:',
    '  rows:',
    ...Array.from({ length: n }, (_, i) => `    - '行${i + 1}'`),
  ];
  const low = itemReports(runRule(rows(2)));
  assert.equal(low.length, 1);
  assert.equal(low[0].data.note, '');
  assert.equal(formatMessage(low[0]), 'table.rows: 2 array items (min: 3)');
  const high = itemReports(runRule(rows(5)));
  assert.equal(formatMessage(high[0]), 'table.rows: 5 array items (max: 4)');
});

test('min_items だけを宣言した制約だと、上限の判定をしない', async () => {
  await explains('`min_items` だけを宣言した制約のテストです。要素が多くても上限の検証をせず、下限に満たない場合だけ `minItems` を報告することを確認します。');
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

test('値が配列でないと、件数の判定をしない', async () => {
  await explains('値が配列でない場合に、件数の検証をしないことを確認します。');
  assert.deepEqual(
    itemReports(runRule(['layout: tc-items-min', 'table:', "  rows: '文字列'"])),
    [],
  );
});

test('min_items を持つフィールドがページに無いと、0 件として minItems を報告する', async () => {
  await explains('`min_items` を持つフィールドがページに存在しない場合のテストです。0 件として扱い、`minItems` を報告することを確認します。');
  const reports = itemReports(runRule(['layout: tc-items-min', "title: 'x'"]));
  assert.deepEqual(
    reports.map((r) => [r.messageId, r.data.fieldPath, r.data.actual]),
    [['minItems', 'table.rows', '0']],
  );
});

test('[] を含むパスの親の配列が空だと、件数を報告しない', async () => {
  await explains('`[]` を含むパスのテストです。親の配列が空の場合に、件数の違反を報告しないことを確認します。');
  const reports = itemReports(
    runRule(['layout: tc-items-no-note', 'table:', "  rows: ['a','b','c']", 'cols: []']),
  );
  assert.deepEqual(reports, []);
});

// fixture deck の実 reference（axis-table.yaml）を読む
test('fixture deck の axis-table.yaml で行を 2 件・列を 1 件にすると、rows と columns の minItems を報告する', async () => {
  await explains('fixture deck の実際の reference（`axis-table.yaml`）を使った、件数の検証のテストです。行が 2 件で列が 1 件の場合に、行と列のそれぞれで `minItems` を報告することを確認します。');
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

test('fixture deck の axis-table.yaml で行を 3 件・列を 2 件にすると、件数の違反を報告しない', async () => {
  await explains('fixture deck の実際の reference（`axis-table.yaml`）を使った、件数の検証のテストです。行が 3 件で列が 2 件の場合に、件数の違反を報告しないことを確認します。');
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

test('max_items だけの制約でも、要素に <em> があると要素ごとに検出する', async () => {
  await explains('`max_items` だけを宣言した制約のテストです。要素が `<em>` を含む場合に、要素ごとに `emDisallowed` を検出することを確認します。');
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

test('値が min_chars に満たないと、minChars を報告する', async () => {
  await explains('`min_chars` の検証のテストです。値が下限の文字数未満の場合に、`minChars` を報告することを確認します。');
  const reports = runRule(['layout: tc-min', "summary: 'あい'"]);
  assert.deepEqual(
    reports.map((r) => r.messageId),
    ['minChars'],
  );
});

// テーマの宣言（layouts.references）が値の出どころであることを、テスト用テーマの references で固定する
test('テーマが宣言した references に text_constraints があると、その上限と下限で文字数を報告する', async () => {
  await explains('テーマが宣言した references の `text_constraints` を使った検証のテストです。見出しが下限に満たず説明が上限を超える場合に、それぞれ `minChars` と `maxChars` を報告することを確認します。');
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
