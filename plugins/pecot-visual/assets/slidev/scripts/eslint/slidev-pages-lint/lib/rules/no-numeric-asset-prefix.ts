import type { Rule } from 'eslint';
import path from 'path';
import { parseFrontmatter, isPlainObject } from '@v-slidev/eslint-shared';
import { resolveFilename, isReferenceFile } from '../utils/page-file.ts';

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|svg|webp)$/i;
const LEADING_DIGIT_REGEX = /^\d/;
// scheme 付き（http: / https: / data: 等）は外部参照としてリネーム対象外
const SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;

// frontmatter の全文字列値を収集する。値の実データ形（object / array / string）で
// 降下するため、レイアウト reference のスキーマには依存しない。
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) {
      collectStrings(child, out);
    }
  }
}

// 数字で始まる画像参照なら basename を返す。該当しなければ null。
function violatingFileName(reference: string): string | null {
  if (SCHEME_REGEX.test(reference) || !IMAGE_EXTENSION_REGEX.test(reference)) {
    return null;
  }
  const fileName = path.posix.basename(reference);
  const stem = fileName.slice(0, fileName.length - path.posix.extname(fileName).length);
  return LEADING_DIGIT_REGEX.test(stem) ? fileName : null;
}

// frontmatter 側の指摘行。quote 表記の差で raw 行に現れない値は 1 行目に寄せる。
function findReferenceLine(text: string, reference: string): number {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(reference)) {
      return i + 1;
    }
  }
  return 1;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow image file names starting with a digit in pages references',
      recommended: true,
    },
    schema: [],
    messages: {
      numericAssetPrefix:
        'image file name starts with a digit: {{fileName}}; the number drifts from the real order when slides are swapped (fix: rename it to a scene-based English name such as lib-circleci-success.png and update the reference paths)',
    },
  },

  create(context) {
    // frontmatter 側: 生テキストを parse して全文字列値を確認する
    function check(node: Rule.Node) {
      if (isReferenceFile(resolveFilename(context))) {
        return;
      }

      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const frontmatter = parseFrontmatter(text);
      if (!frontmatter) {
        return;
      }

      const references: string[] = [];
      collectStrings(frontmatter, references);
      for (const reference of references) {
        const fileName = violatingFileName(reference);
        if (fileName) {
          context.report({
            node,
            loc: { line: findReferenceLine(text, reference), column: 0 },
            messageId: 'numericAssetPrefix',
            data: { fileName },
          });
        }
      }
    }

    // 本文側: markdown/commonmark の image ノード（`![](...)`）を確認する
    function checkImage(node: Rule.Node & { url?: string }) {
      if (isReferenceFile(resolveFilename(context)) || typeof node.url !== 'string') {
        return;
      }
      const fileName = violatingFileName(node.url);
      if (fileName) {
        context.report({ node, messageId: 'numericAssetPrefix', data: { fileName } });
      }
    }

    return {
      root: check,
      Program: check,
      image: checkImage,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
