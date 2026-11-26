import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  stripHtmlTags,
  isFullWidth,
  fullWidthEquivalent,
  validateText,
  hasBoldEmphasis,
  hasDisallowedEmTag,
} from '@v-slidev/eslint-shared';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('stripHtmlTags', () => {
  it('<strong> タグを含む文字列を渡すと、タグを除いた文字列を返す', async () => {
    await explains('`stripHtmlTags` が `<strong>` タグを取り除くテストです。`<strong>` で囲んだ文字列を渡した場合に、タグを除いた文字列が返ることを確認します。');
    assert.strictEqual(stripHtmlTags('<strong>bold</strong>'), 'bold');
  });

  it('<span> タグを含む文字列を渡すと、タグを除いた文字列を返す', async () => {
    await explains('`stripHtmlTags` が `<span>` タグを取り除くテストです。タグと地の文が混在する文字列を渡した場合に、タグだけが除かれて地の文が残ることを確認します。');
    assert.strictEqual(stripHtmlTags('text <span>plain</span> here'), 'text plain here');
  });

  it('複数のタグを含む文字列を渡すと、すべてのタグを除いた文字列を返す', async () => {
    await explains('`stripHtmlTags` が複数のタグを取り除くテストです。`<strong>` と `<span>` が混在する文字列を渡した場合に、すべてのタグが除かれることを確認します。');
    assert.strictEqual(
      stripHtmlTags('<strong>bold</strong> and <span>plain</span>'),
      'bold and plain',
    );
  });

  it('タグが無い文字列を渡すと、そのまま返す', async () => {
    await explains('`stripHtmlTags` にタグを含まない文字列を渡すテストです。タグが存在しない文字列を渡した場合に、入力と同じ文字列が返ることを確認します。');
    assert.strictEqual(stripHtmlTags('plain text'), 'plain text');
  });
});

describe('isFullWidth', () => {
  it('漢字を渡すと、全角と判定する', async () => {
    await explains('`isFullWidth` が漢字を全角と判定するテストです。漢字の文字コードを渡した場合に、`true` が返ることを確認します。');
    assert.strictEqual(isFullWidth('漢'.codePointAt(0) as number), true);
  });

  it('ひらがなを渡すと、全角と判定する', async () => {
    await explains('`isFullWidth` によるひらがなの全角判定のテストです。ひらがなの文字コードを渡した場合に、`true` が返ることを確認します。');
    assert.strictEqual(isFullWidth('あ'.codePointAt(0) as number), true);
  });

  it('カタカナを渡すと、全角と判定する', async () => {
    await explains('`isFullWidth` がカタカナを全角と判定するテストです。カタカナの文字コードを渡した場合に、`true` が返ることを確認します。');
    assert.strictEqual(isFullWidth('ア'.codePointAt(0) as number), true);
  });

  it('全角の記号を渡すと、全角と判定する', async () => {
    await explains('`isFullWidth` が全角の記号を全角と判定するテストです。句点（`。`）の文字コードを渡した場合に、`true` が返ることを確認します。');
    assert.strictEqual(isFullWidth('。'.codePointAt(0) as number), true);
  });

  it('ASCII の文字を渡すと、半角と判定する', async () => {
    await explains('`isFullWidth` が ASCII の文字を半角と判定するテストです。英字の文字コードを渡した場合に、`false` が返ることを確認します。');
    assert.strictEqual(isFullWidth('A'.codePointAt(0) as number), false);
  });

  it('数字を渡すと、半角と判定する', async () => {
    await explains('`isFullWidth` が数字を半角と判定するテストです。数字の文字コードを渡した場合に、`false` が返ることを確認します。');
    assert.strictEqual(isFullWidth('1'.codePointAt(0) as number), false);
  });
});

describe('fullWidthEquivalent', () => {
  it('全角だけの文字列を渡すと、文字数をそのまま返す', async () => {
    await explains('`fullWidthEquivalent` が全角だけの文字列を換算するテストです。全角だけの文字列を渡した場合に、文字数と同じ値が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent('表紙'), 2);
  });

  it('半角だけの文字列を渡すと、文字数に 0.7 を掛けて切り上げた値を返す', async () => {
    await explains('`fullWidthEquivalent` が半角だけの文字列を換算するテストです。半角だけの文字列を渡した場合に、文字数に 0.7 を掛けて切り上げた値が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent('PRESENTATION TITLE'), 13);
  });

  it('全角と半角を含む文字列を渡すと、全角は 1、半角は 0.7 と数えて切り上げた値を返す', async () => {
    await explains('`fullWidthEquivalent` が全角と半角の混在する文字列を換算するテストです。混在する文字列を渡した場合に、全角を 1、半角を 0.7 と数えて切り上げた値が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent('タイトルABC'), 7);
  });

  it('空文字列を渡すと、0 を返す', async () => {
    await explains('`fullWidthEquivalent` に空文字列を渡すテストです。空文字列を渡した場合に、0 が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent(''), 0);
  });

  it('null を渡すと、0 を返す', async () => {
    await explains('`fullWidthEquivalent` に `null` を渡すテストです。`null` を渡した場合に、例外を発生させず 0 が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent(null as unknown as string), 0);
  });

  it('半角の文字数を 0.7 倍して端数が出ると、切り上げた値を返す', async () => {
    await explains('`fullWidthEquivalent` が半角の換算で端数を切り上げるテストです。半角 3 文字を渡した場合に、2.1 ではなく切り上げた 3 が返ることを確認します。');
    assert.strictEqual(fullWidthEquivalent('ABC'), 3);
  });
});

describe('validateText', () => {
  it('max_chars の範囲に収まる文字列だと、エラーを返さない', async () => {
    await explains('`validateText` が `max_chars` の範囲内の文字列を受け入れるテストです。上限に収まる文字列を渡した場合に、エラーが返らないことを確認します。');
    const errors = validateText('Hello', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('max_chars を超える文字列だと、maxChars のエラーを 1 件返す', async () => {
    await explains('`validateText` が `max_chars` を超える文字列を検出するテストです。上限を超える文字列を渡した場合に、種別が `maxChars` のエラーが 1 件返ることを確認します。');
    const errors = validateText('これは非常に長いタイトルテキストです', {
      max_chars: 9,
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'maxChars');
  });

  it('max_chars を定義していないと、上限を確かめない', async () => {
    await explains('`validateText` が `max_chars` を定義していない場合のテストです。上限を定義せずに長い文字列を渡した場合に、上限の検証せずエラーが返らないことを確認します。');
    const errors = validateText('どんなに長いテキストでもエラーにならない', {
      min_chars: 2,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars の範囲に収まる文字列だと、エラーを返さない', async () => {
    await explains('`validateText` が `min_chars` の範囲内の文字列を受け入れるテストです。下限と上限の両方に収まる文字列を渡した場合に、エラーが返らないことを確認します。');
    const errors = validateText('十分な長さのテキスト', {
      min_chars: 3,
      max_chars: 20,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars に満たない文字列だと、minChars のエラーを 1 件返す', async () => {
    await explains('`validateText` が `min_chars` に満たない文字列を検出するテストです。下限に満たない文字列を渡した場合に、種別が `minChars` のエラーが 1 件返ることを確認します。');
    const errors = validateText('AB', { min_chars: 3, max_chars: 20 });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'minChars');
  });

  it('min_chars を定義していないと、下限を確かめない', async () => {
    await explains('`validateText` が `min_chars` を定義していない場合のテストです。下限を定義せずに短い文字列を渡した場合に、下限の検証せずエラーが返らないことを確認します。');
    const errors = validateText('A', { max_chars: 20 });
    assert.deepStrictEqual(errors, []);
  });

  it('文字列に HTML タグが含まれると、タグを文字数に数えない', async () => {
    await explains('`validateText` が HTML タグを文字数に含めないテストです。タグを含む文字列を渡した場合に、タグを除いた文字数で検証され、エラーが返らないことを確認します。');
    const errors = validateText('<strong>Hello</strong>', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('文字列でない値を渡すと、エラーを返さない', async () => {
    await explains('`validateText` に文字列でない値を渡すテストです。数値を渡した場合に、例外を発生させずエラーが返らないことを確認します。');
    const errors = validateText(123 as unknown as string, { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });
});

describe('hasBoldEmphasis', () => {
  it('<strong> で囲んだ部分と地の文があると、true を返す', async () => {
    await explains('`hasBoldEmphasis` が太字の強調を判定するテストです。`<strong>` で囲んだ部分と地の文がある場合に、`true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('要点は<strong>ここ</strong>です'), true);
  });

  it('<strong> に属性が付いていても、true を返す', async () => {
    await explains('`hasBoldEmphasis` が属性付きの `<strong>` を判定するテストです。`<strong>` に `class` 属性が付いている場合でも、`true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('要点は<strong class="hl">ここ</strong>です'), true);
  });

  it('<STRONG> のように大文字でも、true を返す', async () => {
    await explains('`hasBoldEmphasis` が大文字のタグを判定するテストです。`<STRONG>` のように大文字で書いた場合でも、`true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('要点は<STRONG>ここ</STRONG>です'), true);
  });

  it('<strong> の中身が入れ子のタグでも、周囲に地の文があると、true を返す', async () => {
    await explains('`hasBoldEmphasis` が入れ子のタグを判定するテストです。`<strong>` の中身が `<span>` の場合でも、周囲に地の文があれば `true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('要点は<strong><span>ここ</span></strong>です'), true);
  });

  it('全文を <strong> で囲むと、強調の対比が無いので false を返す', async () => {
    await explains('`hasBoldEmphasis` が全文を囲んだ強調を判定するテストです。全文を `<strong>` で囲んだ場合に、強調の対比を持たないため `false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>全文まるごと太字</strong>'), false);
  });

  it('複数の <strong> で全文を覆っても、false を返す', async () => {
    await explains('`hasBoldEmphasis` が複数の `<strong>` で全文を覆う場合のテストです。複数の `<strong>` が全文を覆う場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong><strong>後半</strong>'), false);
  });

  it('複数の <strong> の間が空白だけだと、全文とみなして false を返す', async () => {
    await explains('`hasBoldEmphasis` が `<strong>` の間の空白を判定するテストです。`<strong>` の間が空白だけの場合に、全文とみなして `false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong>  <strong>後半</strong>'), false);
  });

  it('<strong> の外に地の文が 1 文字でもあると、true を返す', async () => {
    await explains('`hasBoldEmphasis` が `<strong>` の外の地の文を判定するテストです。外に地の文が 1 文字でもある場合に、`true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>ほぼ全文太字</strong>。'), true);
  });

  it('<strong> の外が <span> の地の文でも、true を返す', async () => {
    await explains('`hasBoldEmphasis` が `<span>` の地の文を判定するテストです。`<strong>` の外が `<span>` の地の文である場合に、`true` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>要点</strong><span>補足</span>'), true);
  });

  it('<b> だけだと、false を返す', async () => {
    await explains('`hasBoldEmphasis` が `<b>` を強調として扱わないテストです。`<b>` だけで強調した場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('要点は<b>ここ</b>です'), false);
  });

  it('<strong></strong> の中身が空だと、false を返す', async () => {
    await explains('`hasBoldEmphasis` が中身の空の `<strong>` を判定するテストです。`<strong></strong>` の中身が空の場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong></strong>本文'), false);
  });

  it('<strong> の中身が空白だけだと、false を返す', async () => {
    await explains('`hasBoldEmphasis` が空白だけの `<strong>` を判定するテストです。`<strong>` の中身が空白だけの場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>   </strong>本文'), false);
  });

  it('&lt;strong&gt; のようにエンティティになっていると、false を返す', async () => {
    await explains('`hasBoldEmphasis` がエンティティ化されたタグを判定するテストです。`&lt;strong&gt;` のようにエンティティになっている場合に、タグとして扱わず `false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('&lt;strong&gt;ここ&lt;/strong&gt;'), false);
  });

  it('<strong> に閉じタグが無いと、false を返す', async () => {
    await explains('`hasBoldEmphasis` が閉じタグのない `<strong>` を判定するテストです。閉じタグが存在しない場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('<strong>閉じ忘れ'), false);
  });

  it('タグが無いと、false を返す', async () => {
    await explains('`hasBoldEmphasis` がタグを含まない文字列を判定するテストです。太字のタグが存在しない場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis('太字のない本文'), false);
  });

  it('文字列でない値を渡すと、false を返す', async () => {
    await explains('`hasBoldEmphasis` に文字列でない値を渡すテストです。数値を渡した場合に、例外を発生させず `false` が返ることを確認します。');
    assert.strictEqual(hasBoldEmphasis(123 as unknown as string), false);
  });
});

describe('hasDisallowedEmTag', () => {
  it('<em> を含むと、true を返す', async () => {
    await explains('`hasDisallowedEmTag` が `<em>` を検出するテストです。`<em>` を含む文字列を渡した場合に、`true` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('本文は<em>ここ</em>です'), true);
  });

  it('<em> に属性が付いていても、true を返す', async () => {
    await explains('`hasDisallowedEmTag` が属性付きの `<em>` を検出するテストです。`<em>` に `class` 属性が付いている場合でも、`true` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('本文は<em class="hl">ここ</em>です'), true);
  });

  it('<EM> のように大文字でも、true を返す', async () => {
    await explains('`hasDisallowedEmTag` が大文字のタグを検出するテストです。`<EM>` のように大文字で書いた場合でも、`true` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('本文は<EM>ここ</EM>です'), true);
  });

  it('<em> に閉じタグが無くても、true を返す', async () => {
    await explains('`hasDisallowedEmTag` が閉じタグのない `<em>` を検出するテストです。閉じタグが存在しない場合でも、`true` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('本文は<em>閉じ忘れ'), true);
  });

  it('<strong> だけだと、false を返す', async () => {
    await explains('`hasDisallowedEmTag` が `<strong>` を禁止対象にしないテストです。`<strong>` だけを含む文字列を渡した場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('要点は<strong>ここ</strong>です'), false);
  });

  it('タグが無いと、false を返す', async () => {
    await explains('`hasDisallowedEmTag` がタグを含まない文字列を判定するテストです。タグが存在しない場合に、`false` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag('タグのない本文'), false);
  });

  it('文字列でない値を渡すと、false を返す', async () => {
    await explains('`hasDisallowedEmTag` に文字列でない値を渡すテストです。数値を渡した場合に、例外を発生させず `false` が返ることを確認します。');
    assert.strictEqual(hasDisallowedEmTag(123 as unknown as string), false);
  });
});
