"""tests/core/test_sections.py - 必須セクション抽出・検証の共通関数テスト。

抽出・必須・サマリ・記法の 4 関数は issue / comment / pr の 3 コマンドが共有する（#958 F-03）。
コマンドに依らない純粋関数としての挙動と、配布テンプレート実体から抽出した
必須セクションでの駆動をここに集約する。
"""

from __future__ import annotations

from pathlib import Path

import pytest

import cli
from cli.core.sections import (
    CHECKBOX_ERROR,
    CLOSED_HEADINGS_BY_TEMPLATE,
    EMOJI_ERROR,
    FOLD_SUMMARY_BY_TEMPLATE,
    HORIZONTAL_RULE_ERROR,
    PLAN_FOLD_SUMMARY,
    SOFT_BREAK_ERROR,
    SUMMARY_MAX_CHARS,
    SUMMARY_MULTI_SENTENCE_ERROR,
    SUMMARY_NOT_JAPANESE_ERROR,
    extract_sections_from_template,
    has_summary_image,
    validate_body_style,
    validate_closed_headings,
    validate_fold_balance,
    validate_fold_summaries,
    validate_heading_summaries,
    validate_sections,
)

TEMPLATES_ROOT = Path(cli.__file__).parent / "templates"
ISSUE_TEMPLATES_DIR = TEMPLATES_ROOT / "issue"
PR_TEMPLATES_DIR = TEMPLATES_ROOT / "pr"

# fixture の日本語本文と分けて持つ HTML コメントの開きタグと、クエリ付き URL
_COMMENT_OPEN = "<!--"
_QUERY_URL = "https://example.com/a?x=1"

# --- extract_sections_from_template ---


class TestExtractSectionsFromTemplate:
    """テンプレートからの見出し抽出"""

    def test_extract_with_levels(self, tmp_path: Path) -> None:
        """見出しレベルが正しく抽出される"""
        template = tmp_path / "test.md"
        template.write_text(
            """---
issue_ref: ""
---

### 完了した作業
- 内容

#### 残タスク
- なし
""",
            encoding="utf-8",
        )
        result = extract_sections_from_template(template)
        assert result == [(3, "完了した作業"), (4, "残タスク")]

    def test_leading_guide_comment_is_not_extracted(self, tmp_path: Path) -> None:
        """冒頭の書き方ガイド（HTML コメント）の中の見出し行は抽出しない（#1330）"""
        template = tmp_path / "test.md"
        template.write_text(
            """---
issue_ref: ""
---

<!--
書き方:
### 例の見出し — コメントの中
-->

### Done — <完了>
""",
            encoding="utf-8",
        )
        assert extract_sections_from_template(template) == [(3, "Done — <完了>")]

    def test_em_dash_summary_is_kept(self, tmp_path: Path) -> None:
        """em-dash 一行サマリは切り落とさずそのまま返す（検証側が要否を判断する）"""
        template = tmp_path / "test.md"
        template.write_text(
            """---
---

## Verified — <何を検証したか>
## Risks
""",
            encoding="utf-8",
        )
        result = extract_sections_from_template(template)
        assert result == [(2, "Verified — <何を検証したか>"), (2, "Risks")]

    def test_extract_h2_to_h6(self, tmp_path: Path) -> None:
        """##から######まで全てのレベルを抽出"""
        template = tmp_path / "test.md"
        template.write_text(
            """---
---

## レベル2
### レベル3
#### レベル4
##### レベル5
###### レベル6
""",
            encoding="utf-8",
        )
        result = extract_sections_from_template(template)
        assert result == [
            (2, "レベル2"),
            (3, "レベル3"),
            (4, "レベル4"),
            (5, "レベル5"),
            (6, "レベル6"),
        ]

    def test_extract_file_not_exists(self, tmp_path: Path) -> None:
        """ファイルが存在しない場合は空リスト"""
        result = extract_sections_from_template(tmp_path / "nonexistent.md")
        assert result == []

    def test_extract_no_frontmatter(self, tmp_path: Path) -> None:
        """フロントマターがない場合も抽出可能"""
        template = tmp_path / "test.md"
        template.write_text(
            """### セクション1
内容
#### セクション2
内容
""",
            encoding="utf-8",
        )
        result = extract_sections_from_template(template)
        assert result == [(3, "セクション1"), (4, "セクション2")]


# --- validate_sections ---


class TestValidateSections:
    """必須セクション検証（見出しレベル・em-dash サマリ）"""

    def test_all_sections_present(self) -> None:
        """全セクションが正しいレベルで存在する場合は空リスト"""
        body = """
### 完了した作業
- タスク1

### 現在の状態
- 状態1
"""
        result = validate_sections(body, [(3, "完了した作業"), (3, "現在の状態")])
        assert result == []

    def test_missing_section(self) -> None:
        """セクションが不足している場合はレベル付きで返す"""
        body = """
### 完了した作業
- タスク1
"""
        result = validate_sections(body, [(3, "完了した作業"), (3, "現在の状態")])
        assert result == ["### 現在の状態"]

    def test_wrong_heading_level_detected(self) -> None:
        """見出しレベルが違う場合は不足として検出"""
        body = """
## サマリー
テスト

## 完了した作業
- タスク1
"""
        # テンプレートでは ### (level 3) を期待、## があっても不足
        result = validate_sections(body, [(2, "サマリー"), (3, "完了した作業")])
        assert result == ["### 完了した作業"]

    def test_first_h2_requires_its_name(self) -> None:
        """最初の h2 も、ほかの見出しと同じくテンプレの名前で始まる必要がある"""
        assert validate_sections("\n## Summary\nテスト\n", [(2, "Summary")]) == []
        assert validate_sections("\n## 何でもいい見出し\nテスト\n", [(2, "Summary")]) == [
            "## Summary"
        ]

    def test_missing_first_h2(self) -> None:
        """最初の h2 が無い場合は、その名前の見出しの不足として検出"""
        body = """
### 完了した作業
- タスク1
"""
        result = validate_sections(body, [(2, "サマリー"), (3, "完了した作業")])
        assert "## サマリー" in result

    def test_h4_section_detection(self) -> None:
        """#### 形式のセクションを正しく検出"""
        body = """
#### 残タスク
- なし
"""
        result = validate_sections(body, [(4, "残タスク")])
        assert result == []

    def test_h4_wrong_level(self) -> None:
        """h4を期待している箇所にh3があっても不足として検出"""
        body = """
### 残タスク
- なし
"""
        result = validate_sections(body, [(4, "残タスク")])
        assert result == ["#### 残タスク"]

    def test_mixed_levels(self) -> None:
        """異なるレベルの見出しが混在"""
        body = """
### 完了した作業
- タスク1

#### 残タスク
- なし
"""
        result = validate_sections(body, [(3, "完了した作業"), (4, "残タスク"), (4, "確認事項")])
        assert result == ["#### 確認事項"]

    def test_empty_required_sections(self) -> None:
        """required_sectionsが空の場合は空リストを返す"""
        body = "テスト本文"
        result = validate_sections(body, [])
        assert result == []

    def test_special_characters_in_section_name(self) -> None:
        """セクション名に特殊文字が含まれる場合も正しく検出"""
        body = """
### 注意事項・コンテキスト
- 内容
"""
        result = validate_sections(body, [(3, "注意事項・コンテキスト")])
        assert result == []

    def test_partial_match_does_not_count(self) -> None:
        """セクション名の途中マッチは不足扱い（em-dash 区切りが必須）"""
        result = validate_sections(
            "## VerifiedExtra — まぎらわしい\n\n- aaa",
            [(2, "Verified — <サマリ>")],
        )
        assert result == ["## Verified — <サマリ>"]

    def test_em_dash_required_when_template_declares_it(self) -> None:
        """テンプレが em-dash サマリを宣言していれば半角ハイフンは不足扱い"""
        result = validate_sections(
            "## Verified - テスト通過\n\n- aaa",
            [(2, "Verified — <サマリ>")],
        )
        assert result == ["## Verified — <サマリ>"]

    def test_summary_rule_violation_is_not_missing(self) -> None:
        """見出しがあればサマリの規則違反は不足に数えない（validate_heading_summaries の担当）"""
        over = "a" * (SUMMARY_MAX_CHARS + 1) + "。b"
        assert validate_sections(f"## Verified — {over}", [(2, "Verified — <サマリ>")]) == []

    def test_placeholder_is_not_reported_here(self) -> None:
        """未編集プレースホルダの報告は validate_body_style の担当（#962 で移設）"""
        body = "## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>"
        result = validate_sections(body, [(2, "Verified — <サマリ>")])
        assert all("未編集プレースホルダ" not in m for m in result)


class TestValidateHeadingSummaries:
    """em-dash サマリは 50 文字以内・日本語を含む 1 文（#1185）"""

    REQUIRED = [(2, "Verified — <サマリ>")]

    def test_summary_length_is_capped(self) -> None:
        """サマリが上限を超えると文字数付きで返す"""
        over = "あ" * (SUMMARY_MAX_CHARS + 1)
        result = validate_heading_summaries(f"## Verified — {over}", self.REQUIRED)
        assert result == [
            f"## Verified — サマリが{SUMMARY_MAX_CHARS + 1}文字です（上限{SUMMARY_MAX_CHARS}文字）"
        ]

    def test_missing_heading_is_left_to_validate_sections(self) -> None:
        """見出しが無いものは返さない（不足は validate_sections が返す）"""
        assert validate_heading_summaries("## Verified - 通過", self.REQUIRED) == []

    def test_heading_without_em_dash_is_not_checked(self) -> None:
        """em-dash を宣言しない見出しはサマリを確認しない"""
        assert validate_heading_summaries("### Repro\n", [(3, "Repro")]) == []

    def test_ascii_only_summary_is_rejected(self) -> None:
        result = validate_heading_summaries("## Verified — all tests pass", self.REQUIRED)
        assert result == [f"## Verified — {SUMMARY_NOT_JAPANESE_ERROR}"]

    def test_ascii_with_japanese_passes(self) -> None:
        assert validate_heading_summaries("## Verified — v0.5.0 の公開", self.REQUIRED) == []

    @pytest.mark.parametrize(
        "summary",
        ["々", "テスト", "てすと", "検証", "\uff83\uff7d\uff84"],
        ids=["noma", "katakana", "hiragana", "kanji", "halfwidth-kana"],
    )
    def test_each_japanese_script_counts(self, summary: str) -> None:
        assert validate_heading_summaries(f"## Verified — {summary}", self.REQUIRED) == []

    def test_two_sentences_are_rejected(self) -> None:
        result = validate_heading_summaries("## Verified — 通過した。残りなし", self.REQUIRED)
        assert result == [f"## Verified — {SUMMARY_MULTI_SENTENCE_ERROR}"]

    @pytest.mark.parametrize("mark", ["！", "？", "!", "?"])
    def test_other_sentence_marks_in_the_middle_are_rejected(self, mark: str) -> None:
        result = validate_heading_summaries(f"## Verified — 完了{mark} 次へ", self.REQUIRED)
        assert result == [f"## Verified — {SUMMARY_MULTI_SENTENCE_ERROR}"]

    def test_halfwidth_period_is_not_a_sentence_end(self) -> None:
        """`v1.2` のような表記があるため半角 `.` は区切りに数えない"""
        assert validate_heading_summaries("## Verified — v1.2 を公開", self.REQUIRED) == []

    def test_trailing_period_passes(self) -> None:
        assert validate_heading_summaries("## Verified — 全件通過した。", self.REQUIRED) == []

    @pytest.mark.parametrize("summary", ["「完了。」", "（全件通過した。）", "『完了\uff01』"])
    def test_sentence_end_before_closing_bracket_passes(self, summary: str) -> None:
        """閉じ括弧で終わる 1 文は末尾の括弧を除いて判定する"""
        assert validate_heading_summaries(f"## Verified — {summary}", self.REQUIRED) == []

    def test_violations_are_reported_together(self) -> None:
        """文字数・日本語・1 文の違反は同じ見出しについて全て返す"""
        summary = "あ" * (SUMMARY_MAX_CHARS - 1) + "。いい"
        result = validate_heading_summaries(f"## Verified — {summary}", self.REQUIRED)
        assert result == [
            f"## Verified — サマリが{len(summary)}文字です（上限{SUMMARY_MAX_CHARS}文字）",
            f"## Verified — {SUMMARY_MULTI_SENTENCE_ERROR}",
        ]

    def test_first_h2_without_em_dash_has_no_summary_rule(self) -> None:
        """em-dash を宣言しない最初の h2 は、名前の前方一致だけを見る"""
        assert validate_sections("## Release v1", [(2, "Release")]) == []
        assert validate_heading_summaries("## Release v1", [(2, "Release")]) == []


# --- validate_body_style ---


class TestValidateBodyStyleCheckbox:
    """チェックボックス記法の検出（#962）"""

    def test_unchecked_box_is_rejected(self) -> None:
        result = validate_body_style("## Progress — テスト\n\n- [ ] やること\n")
        assert any("チェックボックス記法" in m for m in result)

    def test_checked_box_is_rejected(self) -> None:
        result = validate_body_style("- [x] 完了\n")
        assert any("チェックボックス記法" in m for m in result)

    def test_asterisk_and_plus_bullets_are_rejected(self) -> None:
        assert any("チェックボックス記法" in m for m in validate_body_style("* [ ] a\n"))
        assert any("チェックボックス記法" in m for m in validate_body_style("+ [X] a\n"))

    @pytest.mark.parametrize("line", ["1. [ ] a", "2) [x] b", "10. [X] c"])
    def test_ordered_list_checkbox_is_rejected(self, line: str) -> None:
        assert validate_body_style(f"{line}\n") == [CHECKBOX_ERROR]

    def test_ordered_list_link_is_not_a_checkbox(self) -> None:
        assert validate_body_style("1. [x](https://example.com/x) を参照\n") == []

    def test_link_item_is_not_a_checkbox(self) -> None:
        """`- [x](url)` のようなリンク項目は誤検知しない"""
        body = "- [x](https://example.com/x) を参照\n- [ref](https://example.com/r) も参照\n"
        assert validate_body_style(body) == []

    @pytest.mark.parametrize("line", ["> - [ ] x", "> > * [x] y", "- - [ ] z", ">- [ ] w"])
    def test_checkbox_in_quote_or_nested_list_is_rejected(self, line: str) -> None:
        """引用・入れ子リストの中のタスクリストも GitHub は描画する"""
        assert validate_body_style(f"{line}\n") == [CHECKBOX_ERROR]

    def test_quote_with_link_item_is_not_a_checkbox(self) -> None:
        assert validate_body_style("> - [x](https://example.com/x) を参照\n") == []

    def test_checkbox_reported_once(self) -> None:
        """複数行あってもチェックボックスの報告は 1 件にまとめる"""
        body = "- [ ] a\n- [ ] b\n- [x] c\n"
        assert len([m for m in validate_body_style(body) if "チェックボックス記法" in m]) == 1


class TestValidateBodyStyleMasking:
    """コードフェンス・インラインコード・HTML コメントのマスク（#962）"""

    def test_fenced_block_content_is_ignored(self) -> None:
        body = "## Verified — テスト\n\n```markdown\n- [ ] やること\n<未編集>\n```\n"
        assert validate_body_style(body) == []

    def test_tilde_fence_is_supported(self) -> None:
        body = "~~~\n- [ ] やること\n~~~\n"
        assert validate_body_style(body) == []

    def test_indented_fence_under_list_is_supported(self) -> None:
        """リスト配下のインデントフェンスも中身をマスクする"""
        body = "- 手順\n\n  ```bash\n  - [ ] not a task\n  echo '<未編集>'\n  ```\n\n- 次\n"
        assert validate_body_style(body) == []

    def test_longer_closing_fence_closes_the_block(self) -> None:
        body = "```\n- [ ] a\n````\n\n本文\n"
        assert validate_body_style(body) == []

    def test_unclosed_fence_is_an_error(self) -> None:
        """未閉じフェンスは黙殺せずエラー（フェンス以降の検証バイパス防止）"""
        result = validate_body_style("```bash\necho hi\n\n- [ ] やること\n")
        assert result == ["コードフェンスが閉じられていません"]

    def test_inline_code_is_ignored(self) -> None:
        body = "- 記法 `- [ ]` を使わない\n- 型は `<T>` と書く\n"
        assert validate_body_style(body) == []

    def test_double_backtick_span_is_ignored(self) -> None:
        body = "- ``<`未編集`>`` はコード\n"
        assert validate_body_style(body) == []

    def test_inline_code_run_length_must_match(self) -> None:
        """長さの違うランでは閉じない（``  で開いたスパンは ` では閉じない）"""
        body = "- ``a` <未編集> ``b\n"
        assert validate_body_style(body) == []

    def test_unclosed_backtick_does_not_swallow_the_line(self) -> None:
        """閉じ忘れバッククォート以降のプレースホルダは見逃さない"""
        result = validate_body_style("- `途中で閉じ忘れ <未編集>\n")
        assert any("<未編集>" in m for m in result)

    def test_html_comment_is_ignored(self) -> None:
        body = f"本文\n\n{_COMMENT_OPEN} 生成元: pecot quick / <未編集> / - [ ] -->\n"
        assert validate_body_style(body) == []

    def test_multiline_html_comment_is_ignored(self) -> None:
        body = (
            f"本文\n\n{_COMMENT_OPEN}\n書き方:\n- [ ] は使わない\n<プレースホルダ>\n-->\n\n続き\n"
        )
        assert validate_body_style(body) == []


class TestValidateBodyStyleSoftBreak:
    """段落の中の改行（GitHub は改行のまま表示する）を止める"""

    @pytest.mark.parametrize(
        "body",
        [
            "1 文目。\n2 文目。\n",
            "文 `code`\n続き\n",
            "> 引用の 1 文目。\n> 引用の 2 文目。\n",
        ],
        ids=["paragraph", "inline-code-at-end", "quote"],
    )
    def test_line_break_inside_paragraph_is_rejected(self, body: str) -> None:
        assert SOFT_BREAK_ERROR in validate_body_style(body)

    @pytest.mark.parametrize(
        "body",
        [
            "1 文目。2 文目。\n\n次の段落。\n",
            "- a\n- b\n",
            "- 項目\n  続き\n",
            "| a |\n| b |\n",
            "## 見出し\n本文\n",
            "本文\n```\nx\ny\n```\n",
            "<details>\n<summary>x</summary>\n\n本文\n\n</details>\n",
            "> [!WARNING]\n" "> 注意の文。\n",
            "本文\n> 引用\n",
            "![a](./a.png)\n" "本文\n",
            "明示の改行  \n続き\n",
            "<!--\n冒頭の\n説明\n-->\n",
        ],
        ids=[
            "joined", "list", "list-continuation", "table", "heading", "fence",
            "details", "alert", "paragraph-then-quote", "image", "hard-break", "comment",
        ],
    )  # fmt: skip
    def test_other_line_breaks_pass(self, body: str) -> None:
        assert SOFT_BREAK_ERROR not in validate_body_style(body)


class TestValidateBodyStylePlaceholder:
    """未編集プレースホルダの検出と正当な `<...>` の通過（#962）"""

    def test_japanese_placeholder_is_rejected(self) -> None:
        result = validate_body_style("- **<観測できる状態>** — 確認: 手動\n")
        assert any("<観測できる状態>" in m for m in result)

    def test_ascii_word_placeholder_is_rejected(self) -> None:
        """HTML タグ形状に見える ASCII 語のプレースホルダも通さない"""
        for token in ("<short-sha>", "<NNN-feature>"):
            result = validate_body_style(f"- 参照: {token}\n")
            assert any(token in m for m in result), token

    def test_ascii_word_with_japanese_tail_is_rejected(self) -> None:
        """`<OS 等>` のような ASCII 語 + 空白 + 日本語も通さない"""
        for token in ("<OS 等>", "<AS-IS と TO-BE の差を 1 文で>", "<Step 4 の結果を1行で>"):
            result = validate_body_style(f"- 環境: {token}\n")
            assert any(token in m for m in result), token

    def test_generics_outside_backticks_are_rejected(self) -> None:
        """型・メタ表記は素で書くと落ちる（バッククォートで囲む運用）"""
        assert any("<T>" in m for m in validate_body_style("- list<T> を返す\n"))

    def test_allowed_html_tags_pass(self) -> None:
        body = (
            "<details><summary>ログ</summary>\n\n本文<br>続き\n\n</details>\n"
            f'<kbd>Ctrl</kbd> と <a href="{_QUERY_URL}">リンク</a>\n'
            '<img src="https://example.com/i.png" alt="図" />\n'
        )
        assert validate_body_style(body) == []

    def test_autolinks_pass(self) -> None:
        body = "<https://ghes.example.com/acme-labs/aist-plugin/issues/962>\n<user@example.com>\n"
        assert validate_body_style(body) == []

    def test_comparison_and_version_notation_passes(self) -> None:
        """`<` の直後が英字でないトークンは比較・バージョン表現として通す"""
        body = 'engines "<0.0.0" + engine-strict の <0.0.0> と 応答 <1s> を確認\n'
        assert validate_body_style(body) == []

    def test_release_changelog_transcription_passes(self) -> None:
        """CHANGELOG 転記（release PR の Changes 節）が誤検知されない"""
        body = (
            "## Changes — リリース内容\n\n"
            '- pecotv 全 package に **engines "<0.0.0" + engine-strict** で '
            "npm / yarn 混入を block し、\n"
            "  repo root には逆方向に **pnpm / yarn を block**（npm の既定の流れは温存）"
            "するガードを追加。\n"
        )
        assert validate_body_style(body) == []

    def test_placeholder_in_heading_is_labeled_as_heading(self) -> None:
        body = "## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>"
        result = validate_body_style(body)
        assert any("見出しに未編集プレースホルダ" in m and m.startswith("##") for m in result)
        assert all("details" not in m for m in result)

    def test_nested_angle_brackets_are_reported(self) -> None:
        """`<#<issue番号> <タイトル>>` のような入れ子も中のトークンを拾う"""
        result = validate_body_style("## Merge — <#<issue番号> <タイトル> のサマリ>\n")
        assert any("<issue番号>" in m for m in result)
        assert any("<タイトル>" in m for m in result)

    def test_token_does_not_span_lines(self) -> None:
        """`<` の閉じ忘れが次行以降を飲み込まない"""
        assert validate_body_style("行1 < 未閉じ\n\n行2 > 続き\n") == []

    def test_duplicate_tokens_reported_once(self) -> None:
        body = "- **<観測できる状態>** — a\n- **<観測できる状態>** — b\n"
        assert len(validate_body_style(body)) == 1

    def test_clean_body_passes(self) -> None:
        body = (
            "## Verified — テスト通過\n\n"
            "pytest を全件流した。\n\n"
            "- **単体テスト** — `run-tests.sh --scope=py` が 0 exit\n\n"
            "## Risks — なし\n\n"
            "- **影響範囲** — なし\n"
        )
        assert validate_body_style(body) == []


class TestValidateBodyStyleHorizontalRule:
    """水平線の検出（#1185）"""

    @pytest.mark.parametrize("line", ["---", "***", "___", "- - -", " * * * ", "-----"])
    def test_thematic_break_is_rejected(self, line: str) -> None:
        assert validate_body_style(f"本文\n\n{line}\n\n続き\n") == [HORIZONTAL_RULE_ERROR]

    @pytest.mark.parametrize(
        "line",
        ["> ---", "> > ***", "- ***", "1. ___", "> - ---", "-\t-\t-", "*\t*\t*", "---\t"],
        ids=[
            "quote",
            "nested-quote",
            "list",
            "ordered-list",
            "quote-list",
            "tab-dash",
            "tab-star",
            "trailing-tab",
        ],
    )
    def test_rule_in_quote_list_or_with_tabs_is_rejected(self, line: str) -> None:
        """引用・リストの中の水平線とタブ区切りの水平線も GitHub は描画する"""
        assert validate_body_style(f"本文\n\n{line}\n\n続き\n") == [HORIZONTAL_RULE_ERROR]

    @pytest.mark.parametrize("line", ["- 項目", "> 引用文", "- -- の扱い", "> | a | b |"])
    def test_ordinary_quote_and_list_lines_pass(self, line: str) -> None:
        assert validate_body_style(f"{line}\n") == []

    @pytest.mark.parametrize("tag", ["<hr>", "<hr/>", "<hr />", "<HR>"])
    def test_hr_tag_is_rejected_not_as_placeholder(self, tag: str) -> None:
        assert validate_body_style(f"本文\n\n{tag}\n") == [HORIZONTAL_RULE_ERROR]

    def test_table_delimiter_row_passes(self) -> None:
        body = "| Expected | Actual |\n|---|---|\n| a | b |\n"
        assert validate_body_style(body) == []

    def test_rule_inside_fence_passes(self) -> None:
        assert validate_body_style("```yaml\n---\ntitle: x\n---\n```\n") == []

    def test_quoted_rule_inside_fence_passes(self) -> None:
        assert validate_body_style("```markdown\n> ---\n- ***\n> - [ ] x\n```\n") == []

    def test_quoted_table_delimiter_row_passes(self) -> None:
        assert validate_body_style("> | a | b |\n> |---|---|\n> | 1 | 2 |\n") == []

    def test_rule_inside_inline_code_and_comment_passes(self) -> None:
        assert validate_body_style(f"- 記法 `---` は使わない\n\n{_COMMENT_OPEN}\n---\n-->\n") == []

    def test_four_space_indent_is_not_a_rule(self) -> None:
        """4 スペース以上のインデントは CommonMark では水平線にならない"""
        assert validate_body_style("    ---\n") == []

    def test_reported_once(self) -> None:
        assert validate_body_style("---\n\n***\n\n<hr>\n") == [HORIZONTAL_RULE_ERROR]


class TestValidateBodyStyleEmoji:
    """絵文字の検出（#1185）"""

    @pytest.mark.parametrize("text", ["⚠", "✓", "★", "→", "✗"])
    def test_text_presentation_symbols_pass(self, text: str) -> None:
        assert validate_body_style(f"- {text} 注意点\n") == []

    @pytest.mark.parametrize(
        "text",
        ["✅", "❌", "\u26a0\ufe0f", "🚀", "⭐"],
        ids=["check-mark-button", "cross-mark", "warning-with-vs16", "rocket", "star"],
    )
    def test_emoji_is_rejected(self, text: str) -> None:
        assert validate_body_style(f"- {text} 完了\n") == [EMOJI_ERROR]

    @pytest.mark.parametrize("text", ["㊗", "㊙"], ids=["congratulation", "secret"])
    def test_circled_ideograph_emoji_is_rejected(self, text: str) -> None:
        """Emoji_Presentation=Yes の U+3297 / U+3299"""
        assert validate_body_style(f"{text} 祝\n") == [EMOJI_ERROR]

    @pytest.mark.parametrize(
        "text", [":white_check_mark:", ":thumbsup:", ":rocket:", ":100_a:"], ids=str
    )
    def test_shortcode_is_rejected(self, text: str) -> None:
        """GitHub が絵文字として描画するショートコード"""
        assert validate_body_style(f"- {text} 完了\n") == [EMOJI_ERROR]

    @pytest.mark.parametrize(
        "text",
        ["10:30:00 に実行", "比率 1:2:3", "https://example.com/a:b", "`:rocket:` は使わない"],
        ids=["time", "ratio", "url", "inline-code"],
    )
    def test_colon_text_without_shortcode_passes(self, text: str) -> None:
        assert validate_body_style(f"- {text}\n") == []

    def test_emoji_in_heading_is_rejected(self) -> None:
        assert validate_body_style("## Verified — 🎉 全件通過\n") == [EMOJI_ERROR]

    def test_emoji_inside_code_passes(self) -> None:
        assert validate_body_style("- `✅` は使わない\n\n```\n🚀\n```\n") == []

    def test_reported_once(self) -> None:
        assert validate_body_style("- ✅ a\n- ❌ b\n") == [EMOJI_ERROR]


class TestValidateBodyStyleCombined:
    """記法違反が複数あるとき全種を 1 件ずつ返す"""

    def test_all_rules_reported_in_order(self) -> None:
        body = "## Progress — 途中\n\n1. [ ] a\n\n---\n\n- ✅ b\n- <未編集>\n"
        assert validate_body_style(body) == [
            CHECKBOX_ERROR,
            HORIZONTAL_RULE_ERROR,
            EMOJI_ERROR,
            "未編集プレースホルダ <未編集> が残っています",
        ]


# --- 配布テンプレート実体と検証器の結合 ---


def _section_names(sections: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """(level, "名前 — <サマリ>") から em-dash サマリを落として (level, 名前) にする"""
    return [(level, name.split(" — ", 1)[0]) for level, name in sections]


class TestCreateTemplateSections:
    """pr/create.md 実体から抽出した必須セクションで検証器を駆動する"""

    def test_extracted_sections_are_summary_changes_verified_and_risks(self) -> None:
        """create.md からは h2 の Summary / Changes / Verified / Risks の 4 件だけが抽出される"""
        sections = extract_sections_from_template(PR_TEMPLATES_DIR / "create.md")

        assert _section_names(sections) == [
            (2, "Summary"),
            (2, "Changes"),
            (2, "Verified"),
            (2, "Risks"),
        ]

    def test_all_extracted_sections_are_required(self) -> None:
        """抽出セクションが全部そろって初めて通り、欠けた分だけ不足が返る"""
        sections = extract_sections_from_template(PR_TEMPLATES_DIR / "create.md")
        summary = "## Summary\n\n本文だけで変更が分かる。\n"
        changes = "## Changes\n\nなし\n"
        verified = "## Verified\n\n- xxx\n"
        risks = "## Risks\n\nなし"

        assert validate_sections(f"{summary}\n{changes}\n{verified}\n{risks}", sections) == []
        assert validate_sections(f"{changes}\n{verified}\n{risks}", sections) == ["## Summary"]
        assert validate_sections(f"{summary}\n{verified}\n{risks}", sections) == ["## Changes"]
        assert validate_sections(f"{summary}\n{changes}\n{risks}", sections) == ["## Verified"]
        assert validate_sections(f"{summary}\n{changes}\n{verified}", sections) == ["## Risks"]

    def test_headings_have_no_summary_rule_and_placeholder_is_checked(self) -> None:
        """見出しの後ろの文には規則を掛けず、本文の未編集プレースホルダは弾く。

        プレースホルダは `validate_body_style` が見る（#958 F-03 / #962 / #1185 で検出責務を分離）。
        """
        sections = extract_sections_from_template(PR_TEMPLATES_DIR / "create.md")
        body = (
            "## Summary\n\nテスト用の本文。\n\n## Changes\n\nなし\n\n"
            "## Verified — " + "あ" * 51 + "\n\n## Risks\n\n<レビューで見てほしい点>"
        )

        assert validate_sections(body, sections) == []
        assert validate_heading_summaries(body, sections) == []
        assert any("未編集プレースホルダ" in m for m in validate_body_style(body))


class TestReleaseTemplateSections:
    """pr/release.md 実体から抽出した必須セクションを固定する（#958 F-06）。

    全件必須セマンティクスのため、release.md への見出し追加は
    「全リリース PR に必須節が増える」ことを意味する。増減をここで検出する。
    """

    def test_extracted_sections_are_the_four_release_headings(self) -> None:
        """release.md からは h2 の 4 見出しだけが抽出される"""
        sections = extract_sections_from_template(PR_TEMPLATES_DIR / "release.md")

        assert _section_names(sections) == [
            (2, "Summary"),
            (2, "Changes"),
            (2, "Migration"),
            (2, "Verified"),
        ]

    def test_all_four_are_required(self) -> None:
        """4 見出しがそろって初めて通り、1 つ欠けると不足が返る"""
        sections = extract_sections_from_template(PR_TEMPLATES_DIR / "release.md")
        full = (
            "## Summary\n\n本文\n\n"
            "## Changes\n\n本文\n\n"
            "## Migration\n\nなし\n\n"
            "## Verified\n\n- テスト — pass\n"
        )

        assert validate_sections(full, sections) == []
        without_migration = full.replace("## Migration\n\nなし\n\n", "")
        assert validate_sections(without_migration, sections) == ["## Migration"]


# --- epic テンプレート (AS-IS / TO-BE / GAP) と検証器の結合テスト ---


class TestEpicTemplateSections:
    """epic テンプレート実体から抽出した必須セクションで検証器を駆動する"""

    def test_extracted_sections_are_asis_tobe_gap(self) -> None:
        """epic.md からは h2 の AS-IS / TO-BE / GAP の 3 件だけが抽出される"""
        sections = extract_sections_from_template(ISSUE_TEMPLATES_DIR / "epic.md")

        assert [level for level, _ in sections] == [2, 2, 2]
        assert [name.split(" — ", 1)[0] for _, name in sections] == ["AS-IS", "TO-BE", "GAP"]

    def test_filled_body_passes(self) -> None:
        """3 見出しをサマリ付きで埋めた本文は不足なしと判定される"""
        sections = extract_sections_from_template(ISSUE_TEMPLATES_DIR / "epic.md")
        body = (
            "## AS-IS — 現状\n\n現状の事実\n\n"
            "## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n"
            "## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n"
        )

        assert validate_sections(body, sections) == []

    @staticmethod
    def _body(heading: str) -> str:
        return (
            f"{heading}\n\n現状の事実\n\n"
            "## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n"
            "## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n"
        )

    def test_hyphen_separator_is_missing(self) -> None:
        """区切りが半角ハイフンの見出しは不足として報告される"""
        sections = extract_sections_from_template(ISSUE_TEMPLATES_DIR / "epic.md")
        body = self._body("## AS-IS - 現状")

        assert validate_sections(body, sections) == ["## AS-IS — <サマリ>"]

    def test_over_limit_summary_is_a_summary_violation(self) -> None:
        """サマリの上限超過は不足ではなくサマリの規則違反として報告される"""
        sections = extract_sections_from_template(ISSUE_TEMPLATES_DIR / "epic.md")
        body = self._body(f"## AS-IS — {'あ' * 51}")

        assert validate_sections(body, sections) == []
        assert validate_heading_summaries(body, sections) == [
            "## AS-IS — サマリが51文字です（上限50文字）"
        ]


# --- validate_fold_balance ---


class TestValidateFoldBalance:
    """折りたたみ（<details>）の開閉の対応の検証（#1330）"""

    UNCLOSED = ["<details> が閉じられていません"]
    NO_OPENING = ["<details> に対応する開きタグがありません"]

    def test_closed_templates(self) -> None:
        assert set(CLOSED_HEADINGS_BY_TEMPLATE) == {"plan"}
        assert "Notes" in CLOSED_HEADINGS_BY_TEMPLATE["plan"]

    def test_balanced_fold_is_ok(self) -> None:
        body = "短い\n\n<details>\n<summary>要約</summary>\n\n本文\n\n</details>\n"
        assert validate_fold_balance(body) == []

    def test_outside_length_is_not_limited(self) -> None:
        assert validate_fold_balance("あ" * 20000) == []

    def test_unclosed_details(self) -> None:
        assert validate_fold_balance("<details>\n" + "x" * 500) == self.UNCLOSED

    def test_closing_tag_alone(self) -> None:
        assert validate_fold_balance("本文\n</details>\n") == self.NO_OPENING

    def test_closing_tag_alone_on_a_text_line(self) -> None:
        assert validate_fold_balance("a</details>") == self.NO_OPENING

    def test_closing_before_opening(self) -> None:
        assert validate_fold_balance("</details>\n<details>\n") == self.NO_OPENING

    def test_empty_body(self) -> None:
        assert validate_fold_balance("") == []

    def test_nested_details(self) -> None:
        assert validate_fold_balance("<details>\n<details>\n内\n</details>\n</details>\n") == []

    def test_nested_details_unclosed_outer(self) -> None:
        assert validate_fold_balance("<details>\n<details>\n内\n</details>\n") == self.UNCLOSED

    def test_details_in_list_item(self) -> None:
        assert validate_fold_balance("- <details>\n  本文\n  </details>\n") == []

    def test_details_with_attribute_and_uppercase(self) -> None:
        assert validate_fold_balance("<details open>\nx\n</details>") == []
        assert validate_fold_balance("<DETAILS>\nx\n</DETAILS>") == []

    @pytest.mark.parametrize(
        "body",
        [
            "```html\n<details>\n```\n",
            "`<details>`",
            "<!-- <details> -->\n",
        ],
        ids=["fenced_code", "inline_code", "html_comment"],
    )
    def test_details_in_masked_region_is_not_a_fold(self, body: str) -> None:
        assert validate_fold_balance(body) == []

    def test_other_tags_do_not_fold(self) -> None:
        assert validate_fold_balance("<summary>x</summary>") == []

    def test_unclosed_fence_is_left_to_body_style(self) -> None:
        assert validate_fold_balance("```\n<details>\n") == []


# --- validate_closed_headings ---


class TestValidateClosedHeadings:
    """テンプレに無い ## / ### 見出しの検証（#1330）"""

    SECTIONS = [
        (2, "Plan — <概要>"),
        (3, "Context — <背景>"),
        (3, "Notes — <メモ>"),
        (2, "PECOT-Workflow — <構成>"),
    ]

    def test_template_headings_are_ok(self) -> None:
        body = (
            "## Plan — 計画\n\n### Context — 背景\n\n### Notes — なし\n\n## PECOT-Workflow — 構成\n"
        )
        assert validate_closed_headings(body, self.SECTIONS) == []

    def test_extra_heading_is_returned_with_level(self) -> None:
        body = "## Plan — 計画\n\n### Context — 背景\n\n### Risks — 懸念\n\n## Goal\n"
        assert validate_closed_headings(body, self.SECTIONS) == ["### Risks", "## Goal"]

    def test_same_extra_heading_is_returned_once(self) -> None:
        body = "### Risks — a\n\n### Risks — b\n"
        assert validate_closed_headings(body, self.SECTIONS) == ["### Risks"]

    def test_level_mismatch_is_extra(self) -> None:
        body = "### Plan — 計画\n\n## Context — 背景\n"
        assert validate_closed_headings(body, self.SECTIONS) == ["### Plan", "## Context"]

    def test_heading_without_summary_uses_the_whole_text(self) -> None:
        assert validate_closed_headings("### Steps\n", self.SECTIONS) == ["### Steps"]

    def test_h1_and_h4_or_deeper_are_not_restricted(self) -> None:
        body = "# タイトル\n\n#### CUJ 1\n\n##### 細部\n"
        assert validate_closed_headings(body, self.SECTIONS) == []

    def test_heading_inside_details_is_checked(self) -> None:
        body = "<details>\n<summary>x</summary>\n\n### Steps — 手順\n\n</details>\n"
        assert validate_closed_headings(body, self.SECTIONS) == ["### Steps"]

    @pytest.mark.parametrize(
        "body",
        [
            "```markdown\n### Steps — 例\n```\n",
            "<!--\n### Steps — 例\n-->\n",
            "`### Steps`\n",
        ],
        ids=["fenced_code", "html_comment", "inline_code"],
    )
    def test_heading_in_masked_region_is_ignored(self, body: str) -> None:
        assert validate_closed_headings(body, self.SECTIONS) == []

    def test_unclosed_fence_is_left_to_body_style(self) -> None:
        assert validate_closed_headings("```\n### Steps\n", self.SECTIONS) == []

    def test_plan_template_headings_are_closed_set(self) -> None:
        sections = extract_sections_from_template(TEMPLATES_ROOT / "comment" / "plan.md")
        assert [(level, name.split(" — ")[0]) for level, name in sections] == [
            (2, "Plan"),
            (3, "Context"),
            (3, "Approach"),
            (3, "Files"),
            (3, "Notes"),
            (2, "PECOT-Workflow"),
            (3, "E2E"),
        ]
        body = "\n".join(f"{'#' * level} {name}" for level, name in sections)
        assert validate_closed_headings(body, sections) == []


# --- validate_fold_summaries ---


class TestValidateFoldSummaries:
    """折りたたみの開閉部分（<summary>）の形の検証（#1299）"""

    @staticmethod
    def _fold(summary: str) -> str:
        return f"<details>\n{summary}\n\n本文\n\n</details>\n"

    @staticmethod
    def _error(summary: str) -> str:
        return f"{summary} は {PLAN_FOLD_SUMMARY} にしてください"

    def test_summaries_by_template(self) -> None:
        assert FOLD_SUMMARY_BY_TEMPLATE == {"plan": PLAN_FOLD_SUMMARY}
        assert PLAN_FOLD_SUMMARY == '<summary align="right">詳細はこちら</summary>'

    def test_expected_summaries_pass(self) -> None:
        body = self._fold(PLAN_FOLD_SUMMARY) + "\n- " + self._fold(PLAN_FOLD_SUMMARY)
        assert validate_fold_summaries(body, PLAN_FOLD_SUMMARY) == []

    def test_body_without_summary_passes(self) -> None:
        assert validate_fold_summaries("本文だけ\n", PLAN_FOLD_SUMMARY) == []

    @pytest.mark.parametrize(
        "summary",
        [
            "<summary>詳細はこちら</summary>",
            '<summary align="right">理由</summary>',
            '<summary align="center">詳細はこちら</summary>',
            '<summary align="right"><b>詳細はこちら</b></summary>',
        ],
    )
    def test_other_summary_is_rejected(self, summary: str) -> None:
        assert validate_fold_summaries(self._fold(summary), PLAN_FOLD_SUMMARY) == [
            self._error(summary)
        ]

    def test_summary_split_over_lines_is_rejected(self) -> None:
        body = (
            '<details>\n<summary align="right">\n詳細はこちら\n</summary>\n\n本文\n\n</details>\n'
        )
        assert validate_fold_summaries(body, PLAN_FOLD_SUMMARY) == [
            self._error('<summary align="right">')
        ]

    def test_same_violation_is_reported_once(self) -> None:
        body = self._fold("<summary>理由</summary>") * 2
        assert validate_fold_summaries(body, PLAN_FOLD_SUMMARY) == [
            self._error("<summary>理由</summary>")
        ]

    @pytest.mark.parametrize(
        "body",
        [
            "```html\n<summary>理由</summary>\n```\n",
            "`<summary>理由</summary>` の形は使わない\n",
            _COMMENT_OPEN + " <summary>理由</summary> -->\n",
        ],
    )
    def test_code_and_comment_are_ignored(self, body: str) -> None:
        assert validate_fold_summaries(body, PLAN_FOLD_SUMMARY) == []

    def test_unclosed_fence_is_left_to_body_style(self) -> None:
        assert validate_fold_summaries("```\n<summary>理由</summary>", PLAN_FOLD_SUMMARY) == []


_IMG = "![x](./x.png)"


class TestHasSummaryImage:
    """has_summary_image: Summary セクションの画像参照を数える（#183）"""

    @pytest.mark.parametrize(
        "image",
        [
            "![x](./x.png)",
            "![x][ref]",
            '<img src="a.png">',
            '<IMG src="a.png">',
            "![](https://github.com/user-attachments/assets/1)",
            "![a [x]](./a.png)",
        ],
    )
    def test_counts_image_forms(self, image: str) -> None:
        assert has_summary_image(f"## Summary — 要点\n\n{image}\n\n## Changes\n\nなし\n")

    def test_no_image(self) -> None:
        assert not has_summary_image("## Summary — 要点\n\n本文。\n\n## Changes\n\nなし\n")

    def test_empty_destination_is_not_an_image(self) -> None:
        assert not has_summary_image("## Summary\n\n![a]()\n")

    def test_shortcut_reference_is_not_counted(self) -> None:
        assert not has_summary_image("## Summary\n\n![x]\n")

    def test_indented_headings_are_recognized(self) -> None:
        assert has_summary_image("  ## Summary\n\n" + _IMG + "\n")
        assert not has_summary_image("## Summary\n\n  ## Changes\n\n" + _IMG + "\n")

    def test_bare_h2_ends_summary(self) -> None:
        assert not has_summary_image("## Summary\n\n##\n\n" + _IMG + "\n")

    def test_plain_link_is_not_an_image(self) -> None:
        assert not has_summary_image("## Summary\n\n[x](./x.png)\n")

    def test_image_outside_summary_is_ignored(self) -> None:
        body = "## Summary — 要点\n\n本文。\n\n## Changes\n\n" + _IMG + "\n"
        assert not has_summary_image(body)

    def test_no_summary_heading(self) -> None:
        assert not has_summary_image("## Changes\n\n![x](./x.png)\n")

    def test_h3_does_not_end_summary(self) -> None:
        assert has_summary_image("## Summary\n\n### 詳細\n\n" + _IMG + "\n\n## Changes\n")

    def test_fenced_code_is_ignored(self) -> None:
        body = "## Summary\n\n```markdown\n![x](./x.png)\n```\n\n## Changes\n"
        assert not has_summary_image(body)

    def test_inline_code_is_ignored(self) -> None:
        assert not has_summary_image("## Summary\n\n`![x](./x.png)`\n")

    def test_html_comment_is_ignored(self) -> None:
        body = "## Summary\n\n<!--\n![x](./x.png)\n-->\n\n## Changes\n"
        assert not has_summary_image(body)

    def test_guide_comment_example_is_not_counted(self) -> None:
        """-m の本文に残ったガイドコメントの Summary と画像の例を数えない"""
        body = (
            "<!--\n## Summary — 例\n\n" + _IMG + "\n-->\n\n"
            "## Summary — 要点\n\n本文。\n\n## Changes\n"
        )
        assert not has_summary_image(body)

    def test_summary_heading_inside_fence_is_ignored(self) -> None:
        body = "```\n## Summary\n```\n\n![x](./x.png)\n"
        assert not has_summary_image(body)

    def test_summary_prefix_heading_is_not_summary(self) -> None:
        assert not has_summary_image("## Summaryish\n\n![x](./x.png)\n")
