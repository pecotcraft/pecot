import { describe, it } from 'node:test';
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
  it('<strong>タグ除去', () => {
    assert.strictEqual(stripHtmlTags('<strong>bold</strong>'), 'bold');
  });

  it('<span>タグ除去', () => {
    assert.strictEqual(stripHtmlTags('text <span>plain</span> here'), 'text plain here');
  });

  it('複数タグ除去', () => {
    assert.strictEqual(
      stripHtmlTags('<strong>bold</strong> and <span>plain</span>'),
      'bold and plain',
    );
  });

  it('タグなし → 変更なし', () => {
    assert.strictEqual(stripHtmlTags('plain text'), 'plain text');
  });
});

describe('isFullWidth', () => {
  it('CJK漢字は全角', () => {
    assert.strictEqual(isFullWidth('漢'.codePointAt(0) as number), true);
  });

  it('ひらがなは全角', () => {
    assert.strictEqual(isFullWidth('あ'.codePointAt(0) as number), true);
  });

  it('カタカナは全角', () => {
    assert.strictEqual(isFullWidth('ア'.codePointAt(0) as number), true);
  });

  it('全角記号は全角', () => {
    assert.strictEqual(isFullWidth('。'.codePointAt(0) as number), true);
  });

  it('ASCII文字は半角', () => {
    assert.strictEqual(isFullWidth('A'.codePointAt(0) as number), false);
  });

  it('数字は半角', () => {
    assert.strictEqual(isFullWidth('1'.codePointAt(0) as number), false);
  });
});

describe('fullWidthEquivalent', () => {
  it('全角のみ: "表紙" → 2', () => {
    assert.strictEqual(fullWidthEquivalent('表紙'), 2);
  });

  it('半角のみ: "PRESENTATION TITLE" → 18*0.7 = 12.6 → 切り上げ13', () => {
    assert.strictEqual(fullWidthEquivalent('PRESENTATION TITLE'), 13);
  });

  it('混合: "タイトルABC" → 4*1 + 3*0.7 = 6.1 → 切り上げ7', () => {
    assert.strictEqual(fullWidthEquivalent('タイトルABC'), 7);
  });

  it('空文字列 → 0', () => {
    assert.strictEqual(fullWidthEquivalent(''), 0);
  });

  it('null → 0', () => {
    assert.strictEqual(fullWidthEquivalent(null as unknown as string), 0);
  });

  it('半角奇数文字: "ABC" → 3*0.7 = 2.1 → 切り上げ3', () => {
    assert.strictEqual(fullWidthEquivalent('ABC'), 3);
  });
});

describe('validateText', () => {
  it('max_chars 制約内 → エラーなし', () => {
    const errors = validateText('Hello', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('max_chars 超過 → maxCharsエラー', () => {
    const errors = validateText('これは非常に長いタイトルテキストです', {
      max_chars: 9,
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'maxChars');
  });

  it('max_chars 未定義 → maxチェックしない', () => {
    const errors = validateText('どんなに長いテキストでもエラーにならない', {
      min_chars: 2,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars 制約内 → エラーなし', () => {
    const errors = validateText('十分な長さのテキスト', {
      min_chars: 3,
      max_chars: 20,
    });
    assert.deepStrictEqual(errors, []);
  });

  it('min_chars 不足 → minCharsエラー', () => {
    const errors = validateText('AB', { min_chars: 3, max_chars: 20 });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].type, 'minChars');
  });

  it('min_chars 未定義 → minチェックしない', () => {
    const errors = validateText('A', { max_chars: 20 });
    assert.deepStrictEqual(errors, []);
  });

  it('HTMLタグはカウントしない', () => {
    const errors = validateText('<strong>Hello</strong>', { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });

  it('非文字列値 → エラーなし', () => {
    const errors = validateText(123 as unknown as string, { max_chars: 9 });
    assert.deepStrictEqual(errors, []);
  });
});

describe('hasBoldEmphasis', () => {
  it('<strong> で囲まれた文字列 → true', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong>ここ</strong>です'), true);
  });

  it('属性付き <strong> → true', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong class="hl">ここ</strong>です'), true);
  });

  it('大文字 <STRONG> → true', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<STRONG>ここ</STRONG>です'), true);
  });

  it('<strong> の中身が入れ子タグでも周囲に地の文があれば true', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<strong><span>ここ</span></strong>です'), true);
  });

  it('全文を <strong> で囲むと強調の対比が無いので false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>全文まるごと太字</strong>'), false);
  });

  it('複数の <strong> で全文を覆っても false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong><strong>後半</strong>'), false);
  });

  it('複数の <strong> の間が空白だけでも全文扱いで false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>前半</strong>  <strong>後半</strong>'), false);
  });

  it('全文 <strong> でも外に地の文が1文字でもあれば true', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>ほぼ全文太字</strong>。'), true);
  });

  it('<strong> の外が <span> の地の文でも true', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>要点</strong><span>補足</span>'), true);
  });

  it('<b> のみ → false', () => {
    assert.strictEqual(hasBoldEmphasis('要点は<b>ここ</b>です'), false);
  });

  it('空の <strong></strong> → false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong></strong>本文'), false);
  });

  it('空白のみの <strong> → false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>   </strong>本文'), false);
  });

  it('エンティティ化された &lt;strong&gt; → false', () => {
    assert.strictEqual(hasBoldEmphasis('&lt;strong&gt;ここ&lt;/strong&gt;'), false);
  });

  it('閉じタグのない <strong> → false', () => {
    assert.strictEqual(hasBoldEmphasis('<strong>閉じ忘れ'), false);
  });

  it('タグなし → false', () => {
    assert.strictEqual(hasBoldEmphasis('太字のない本文'), false);
  });

  it('非文字列値 → false', () => {
    assert.strictEqual(hasBoldEmphasis(123 as unknown as string), false);
  });
});

describe('hasDisallowedEmTag', () => {
  it('<em> を含む → true', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em>ここ</em>です'), true);
  });

  it('属性付き <em> → true', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em class="hl">ここ</em>です'), true);
  });

  it('大文字 <EM> → true', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<EM>ここ</EM>です'), true);
  });

  it('閉じタグのない <em> → true', () => {
    assert.strictEqual(hasDisallowedEmTag('本文は<em>閉じ忘れ'), true);
  });

  it('<strong> のみ → false', () => {
    assert.strictEqual(hasDisallowedEmTag('要点は<strong>ここ</strong>です'), false);
  });

  it('タグなし → false', () => {
    assert.strictEqual(hasDisallowedEmTag('タグのない本文'), false);
  });

  it('非文字列値 → false', () => {
    assert.strictEqual(hasDisallowedEmTag(123 as unknown as string), false);
  });
});
