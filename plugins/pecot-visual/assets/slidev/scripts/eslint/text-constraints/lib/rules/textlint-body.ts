import type { MarkdownRuleDefinition, MarkdownSourceCode } from '@eslint/markdown';
import { extractBody } from '../utils/body-extractor.ts';
import type { CommentRange, RemovedSpan } from '../utils/body-extractor.ts';
import { lintText } from '../textlint/client.ts';
import type { TextFinding } from '@pecot/text-rules';

type Root = MarkdownSourceCode['ast'];
type Node = Root | Root['children'][number];

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

// CommonMark の HTML ブロックは、`-->` を含む行の全体を 1 つの html ノードにする。
// ノード内のコメント開始の記号から最初の終了の記号（閉じていなければ末尾）までを 1 件ずつの範囲にし、外の文字は本文に残す。
// コードブロックやインラインコードの中のコメントは html ノードにならないので、構文解析器に除かせる
function collectComments(node: Node, text: string, out: CommentRange[]): void {
  if (node.type === 'html' && node.position) {
    const nodeStart = node.position.start.offset ?? 0;
    const nodeEnd = node.position.end.offset ?? nodeStart;
    const source = text.slice(nodeStart, nodeEnd);
    let from = source.indexOf(COMMENT_OPEN);
    while (from !== -1) {
      const close = source.indexOf(COMMENT_CLOSE, from + COMMENT_OPEN.length);
      const to = close === -1 ? source.length : close + COMMENT_CLOSE.length;
      out.push({ start: nodeStart + from, end: nodeStart + to });
      from = source.indexOf(COMMENT_OPEN, to);
    }
    return;
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectComments(child, text, out);
    }
  }
}

// 本文から消したコメントの分だけ、同じ行でコメントより後ろにある指摘の桁を元に戻す
function restoreColumn(removed: readonly RemovedSpan[], line: number, column: number): number {
  let shift = 0;
  for (const span of removed) {
    if (span.line === line && column - 1 >= span.column - 1 - shift) {
      shift += span.length;
    }
  }
  return column + shift;
}

const rule: MarkdownRuleDefinition = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Check the body and speaker notes (HTML comments) of a page with textlint, reporting file lines',
      recommended: true,
    },
    schema: [],
    messages: {
      textlintBody: '本文 L{{line}}: {{message}}（{{ruleId}}）',
      textlintNotes: '発表者ノート L{{line}}: {{message}}（{{ruleId}}）',
      textlintFailed: 'textlint を実行できませんでした: {{reason}}',
    },
  },

  create(context) {
    function check(node: Node) {
      const text = context.sourceCode.text;
      const comments: CommentRange[] = [];
      collectComments(context.sourceCode.ast, text, comments);
      const { body, bodyStartLine, notes, removed } = extractBody(text, comments);

      const targets = [
        { messageId: 'textlintBody', text: body, startLine: bodyStartLine, startColumn: 1, removed },
        ...notes.map((note) => ({ messageId: 'textlintNotes', removed: [] as RemovedSpan[], ...note })),
      ];

      for (const target of targets) {
        // 空の対象では worker を起動しない（辞書の読み込みに約 200ms かかる）
        if (target.text.trim() === '') {
          continue;
        }
        let findings: readonly TextFinding[];
        try {
          findings = lintText(target.text, 'markdown');
        } catch (error) {
          // worker の起動失敗・textlint の例外で ESLint 全体を落とさず、実行不能を 1 件だけ報告する
          context.report({
            node,
            messageId: 'textlintFailed',
            data: { reason: error instanceof Error ? error.message : String(error) },
          });
          return;
        }
        for (const finding of findings) {
          const line = target.startLine + finding.line - 1;
          const column = restoreColumn(
            target.removed,
            line,
            finding.line === 1 ? target.startColumn + finding.column - 1 : finding.column,
          );
          context.report({
            node,
            loc: { start: { line, column }, end: { line, column } },
            messageId: target.messageId,
            data: { line: String(line), message: finding.message, ruleId: finding.ruleId },
          });
        }
      }
    }

    return {
      root: check,
    };
  },
};

export default rule;
