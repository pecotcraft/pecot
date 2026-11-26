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

describe('stripHtmlTags', () => {
  it('<strong> タグを含む文字列を渡すと、タグを除いた文字列を返す', () => {
    assert.strictEqual(stripHtmlTags('<strong>bold</strong>'), 'bold');
  });

  it('<span> タグを含む文字列を渡すと、タグを除いた文字列を返す', () => {
    assert.strictEqual(stripHtmlTags('text <span>plain</span> here'), 'text plain here');
  });

  it('複数のタグを含む文字列を渡すと、すべてのタグを除いた文字列を返す', () => {
    assert.strictEqual(
      stripHtmlTags('<strong>bold</strong> and <span>plain</span>'),
      'bold and plain',
    );
  });

  it('タグが無い文字列を渡すと、そのまま返す', () => {
    assert.strictEqual(stripHtmlTags('plain text'), 'plain text');
  });
});

describe('isFullWidth', () => {
  it('漢字を渡すと、全角と判定する', () => {
    assert.strictEqual(isFullWidth('漢'.codePointAt(0) as number), true);
  });

  it('ひらがなを渡すと、全角と判定する', () => {
    assert.strictEqual(isFullWidth('あ'.codePointAt(0) as number), true);
  });

  it('カタカナを渡すと、全角と判定する', () => {
    assert.strictEqual(isFullWidth('ア'.codePointAt(0) as number), true);
  });

  it('全角の記号を渡すと、全角と判定する', () => {
    assert.strictEqual(isFullWidth('。'.codePointAt(0) as number), true);
  });

  it('ASCII の文字を渡すと、半角と判定する', () => {
    assert.strictEqual(isFullWidth('A'.codePointAt(0) as number), false);
  });

  it('数字を渡すと、半角と判定する', () => {
    assert.strictEqual(isFullWidth('1'.codePointAt(0) as number), false);
  });
});

describe('fullWidthEquivalent', () => {
  it('全角だけの文字列を渡すと、文字数をそのまま返す', () => {
    assert.strictEqual(fullWidthEquivalent('表紙'), 2);
  });

  it('半角だけの文字列を渡すと、文字数に 0.7 を掛けて切り上げた値を返す', () => {
    assert.strictEqual(fullWidthEquivalent('PRESENTATION TITLE'), 13);
  });

  it('全角と半角を含む文字列を渡すと、全角は 1、半角は 0.7 と数えて切り上げた値を返す', () => {
    assert.strictEqual(fullWidthEquivalent('タイトルABC'), 7);
  });

  it('空文字列を渡すと、0 を返す', () => {
    assert.strictEqual(fullWidthEquivalent(''), 0);
  });

  it('null を渡すと、0 を返す', () => {
    assert.strictEqual(fullWidthEquivalent(null as unknown as string), 0);
  });

  it('半角の文字数を 0.7 倍して端数が出ると、切り上げた値を返す', () => {
    assert.strictEqual(fullWidthEquivalent('ABC'), 3);
  });
});

describe('validateText', () => {
  it('max_chars の範囲に収まる文字列だと、エラーを返さない', () => {
    const errors = validateText('Hello', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('max_chars を超える文字列だと、maxChars のエラーを 1 件返す', () => {
    const errors = validateText('これは非常に長いタイトルテキストです', {
      max_chars: 9,
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'maxChars');
  });

  it('max_chars を定義していないと、上限を確かめない', () => {
    const errors = validateText('どんなに長いテキストでもエラーにならない', {
      min_chars: 2,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars の範囲に収まる文字列だと、エラーを返さない', () => {
    const errors = validateText('十分な長さのテキスト', {
      min_chars: 3,
      max_chars: 20,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars に満たない文字列だと、minChars のエラーを 1 件返す', () => {
    const errors = validateText('AB', { min_chars: 3, max_chars: 20 });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'minChars');
  });

  it('min_chars を定義していないと、下限を確かめない', () => {
    const errors = validateText('A', { max_chars: 20 });
    assert.deepStrictEqual(errors, []);
  });

  it('文字列に HTML タグが含まれると、タグを文字数に数えない', () => {
    const errors = validateText('<strong>Hello</strong>', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('文字列でない値を渡すと、エラーを返さない', () => {
    const errors = validateText(123 as unknown as string, { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });
});

describe('hasBoldEmphasis', () => {
  it('<strong> で囲んだ部分と地の文があると、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong>ここ</strong>です'), true);
  });

  it('<strong> に属性が付いていても、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong class="hl">ここ</strong>です'), true);
  });

  it('<STRONG> のように大文字でも、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<STRONG>ここ</STRONG>です'), true);
  });

  it('<strong> の中身が入れ子のタグでも、周囲に地の文があると、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong><span>ここ</span></strong>です'), true);
  });

  it('全文を <strong> で囲むと、強調の対比が無いので false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>全文まるごと太字</strong>'), false);
  });

  it('複数の <strong> で全文を覆っても、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong><strong>後半</strong>'), false);
  });

  it('複数の <strong> の間が空白だけだと、全文とみなして false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong>  <strong>後半</strong>'), false);
  });

  it('<strong> の外に地の文が 1 文字でもあると、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>ほぼ全文太字</strong>。'), true);
  });

  it('<strong> の外が <span> の地の文でも、true を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>要点</strong><span>補足</span>'), true);
  });

  it('<b> だけだと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<b>ここ</b>です'), false);
  });

  it('<strong></strong> の中身が空だと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong></strong>本文'), false);
  });

  it('<strong> の中身が空白だけだと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>   </strong>本文'), false);
  });

  it('&lt;strong&gt; のようにエンティティになっていると、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('&lt;strong&gt;ここ&lt;/strong&gt;'), false);
  });

  it('<strong> に閉じタグが無いと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>閉じ忘れ'), false);
  });

  it('タグが無いと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis('太字のない本文'), false);
  });

  it('文字列でない値を渡すと、false を返す', () => {
    assert.strictEqual(hasBoldEmphasis(123 as unknown as string), false);
  });
});

describe('hasDisallowedEmTag', () => {
  it('<em> を含むと、true を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em>ここ</em>です'), true);
  });

  it('<em> に属性が付いていても、true を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em class="hl">ここ</em>です'), true);
  });

  it('<EM> のように大文字でも、true を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<EM>ここ</EM>です'), true);
  });

  it('<em> に閉じタグが無くても、true を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em>閉じ忘れ'), true);
  });

  it('<strong> だけだと、false を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('要点は<strong>ここ</strong>です'), false);
  });

  it('タグが無いと、false を返す', () => {
    assert.strictEqual(hasDisallowedEmTag('タグのない本文'), false);
  });

  it('文字列でない値を渡すと、false を返す', () => {
    assert.strictEqual(hasDisallowedEmTag(123 as unknown as string), false);
  });
});
