"""core/sections.py - テンプレート由来の必須セクション抽出・検証

`--prepare` が配る雛形の見出し構成を基準に、投稿本文が雛形どおりに編集されているかを判定する。
issue / comment / pr の 3 コマンドが同じ厳しさで検証するよう、抽出器と検証器をここに集約する（#958 F-03）。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

from cli.core.frontmatter import strip_leading_html_comment

# 見出しの em-dash 一行サマリの上限文字数
SUMMARY_MAX_CHARS = 50

# テンプレに無い `##` / `###` 見出しを拒否するテンプレ名（template_path.stem）と、
# 拒否したときに添える案内文。テンプレごとに閉じた見出しの集合を持たせる（#1330）
CLOSED_HEADINGS_BY_TEMPLATE: dict[str, str] = {
    "plan": "他の見出しに収まらない内容は ### Notes に書いてください",
}

# 折りたたみの開閉部分（<summary>）に許す唯一の形。文言を揃え、開閉部分を右寄せにする
# （GitHub は style / class を除去するため、残る align 属性で寄せる）。テンプレ名ごとに検証を掛ける
PLAN_FOLD_SUMMARY = '<summary align="right">詳細はこちら</summary>'
FOLD_SUMMARY_BY_TEMPLATE: dict[str, str] = {"plan": PLAN_FOLD_SUMMARY}

# 検証エラー文。テンプレの規約ブロックとの対応を tests/unit/test_template_rules.py が固定する
CHECKBOX_ERROR = "チェックボックス記法 (- [ ] / 1. [ ]) は使用できません"
HORIZONTAL_RULE_ERROR = "水平線は使用できません"
EMOJI_ERROR = "絵文字は使用できません"
SOFT_BREAK_ERROR = (
    "段落の中で改行しています。GitHub は改行をそのまま表示するので、"
    "段落は 1 行で書き、段落の間は空行で分けてください"
)
SUMMARY_NOT_JAPANESE_ERROR = "サマリに日本語が含まれていません"
SUMMARY_MULTI_SENTENCE_ERROR = "サマリは 1 文で書いてください"

# GitHub が Markdown 描画時にサニタイズせず通す HTML タグのうち、投稿本文で
# 実際に使うもの。この一覧に無いタグ形状の <...> は未編集プレースホルダ扱い
# （`<T>` のような型・メタ表記はバッククォートで囲んで書く）。
_ALLOWED_HTML_TAGS = frozenset(
    {
        "a",
        "b",
        "blockquote",
        "br",
        "code",
        "details",
        "div",
        "em",
        "i",
        "img",
        "kbd",
        "li",
        "ol",
        "p",
        "pre",
        "span",
        "strong",
        "sub",
        "summary",
        "sup",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    }
)

_FENCE_RE = re.compile(r"^([ \t]*)(`{3,}|~{3,})(.*)$")
_BACKTICK_RUN_RE = re.compile(r"`+")
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_CHECKBOX_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](\s|$)")
# 水平線（thematic break）。setext 見出しの下線 `---` も同じ形で弾く（テンプレは ATX 見出しのみ）。
# CommonMark は区切りにタブも許す
_THEMATIC_BREAK_RE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
# 引用（`>`）とリストマーカーの接頭辞。剥がした残りにも水平線・タスクリスト判定を当てる
_BLOCKQUOTE_PREFIX_RE = re.compile(r"^[ \t]*>[ \t]?")
_LIST_MARKER_PREFIX_RE = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+")
# 絵文字ショートコード（`:white_check_mark:` 等）。英字を含むものだけ（`10:30:00` は通す）
_EMOJI_SHORTCODE_RE = re.compile(r":[a-z0-9_+-]*[a-z][a-z0-9_+-]*:")
# Emoji_Presentation=Yes の BMP 文字。
# 出典: Unicode 15.1 emoji-data.txt（Date: 2023-02-01）の Emoji_Presentation 行のうち U+1F000 未満。
# `⚠` `✓` `★` `→` `✗` は Emoji_Presentation=No なので含めない（U+FE0F を伴えば絵文字扱い）
_EMOJI_PRESENTATION_BMP = frozenset(
    chr(cp)
    for first, last in (
        (0x231A, 0x231B),
        (0x23E9, 0x23EC),
        (0x23F0, 0x23F0),
        (0x23F3, 0x23F3),
        (0x25FD, 0x25FE),
        (0x2614, 0x2615),
        (0x2648, 0x2653),
        (0x267F, 0x267F),
        (0x2693, 0x2693),
        (0x26A1, 0x26A1),
        (0x26AA, 0x26AB),
        (0x26BD, 0x26BE),
        (0x26C4, 0x26C5),
        (0x26CE, 0x26CE),
        (0x26D4, 0x26D4),
        (0x26EA, 0x26EA),
        (0x26F2, 0x26F3),
        (0x26F5, 0x26F5),
        (0x26FA, 0x26FA),
        (0x26FD, 0x26FD),
        (0x2705, 0x2705),
        (0x270A, 0x270B),
        (0x2728, 0x2728),
        (0x274C, 0x274C),
        (0x274E, 0x274E),
        (0x2753, 0x2755),
        (0x2757, 0x2757),
        (0x2795, 0x2797),
        (0x27B0, 0x27B0),
        (0x27BF, 0x27BF),
        (0x2B1B, 0x2B1C),
        (0x2B50, 0x2B50),
        (0x2B55, 0x2B55),
        (0x3297, 0x3297),
        (0x3299, 0x3299),
    )
    for cp in range(first, last + 1)
)
# 絵文字面（Mahjong / Domino / Playing Cards から Symbols and Pictographs Extended-A まで）。
# この範囲にある非絵文字ブロック（Enclosed Alphanumeric Supplement 等）も意図して弾く。
# 本文で使う場面が無く、範囲指定を単純に保つため。
_EMOJI_PLANE_FIRST = 0x1F000
_EMOJI_PLANE_LAST = 0x1FAFF
# 異体字セレクタ 16（直前の文字を絵文字表示にする）
_EMOJI_VARIATION_SELECTOR = "\ufe0f"
# サマリの日本語判定: ひらがな・カタカナ・CJK 統合漢字・々・半角カナ
_JAPANESE_CHAR_RE = re.compile(r"[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3005\uff66-\uff9f]")
# 文の区切り。半角 `.` は `v1.2` のような表記があるため含めない
_SENTENCE_END_CHARS = "。！？!?"
# 1 文判定の前にサマリ末尾から除く閉じ括弧類（`「完了。」` を 1 文として扱う）
_CLOSING_BRACKETS = "」』）】〕〉》］｝\"'”’)]}"
_HEADING_RE = re.compile(r"^(#{2,6})\s")
# 閉じた見出しの集合で縛る見出し（h2 と h3）
_CLOSED_HEADING_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$")
# `<...>` トークン。改行を跨がせない（閉じ忘れで本文全体を飲み込むのを防ぐ）
_TOKEN_RE = re.compile(r"<[^<>\n]+>")
_HTML_TAG_RE = re.compile(r"^</?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?/?>$")
_AUTOLINK_URI_RE = re.compile(r"^<[A-Za-z][A-Za-z0-9+.\-]*://[^<>\s]*>$")
_AUTOLINK_EMAIL_RE = re.compile(r"^<[^<>\s@]+@[^<>\s]+>$")


def extract_sections_from_template(template_path: Path) -> list[tuple[int, str]]:
    """テンプレートから見出しセクションを動的に抽出する（レベル情報付き）。

    冒頭の書き方ガイド（HTML コメント）は見出しの抽出対象から外す。

    Args:
        template_path: テンプレートファイルのパス。

    Returns:
        (level, section_name) のタプルリスト（見出し文字列は em-dash サマリ込み）。
        例: [(2, "Progress — <現在地を1行で>"), ...]
    """
    if not template_path.exists():
        return []

    try:
        content = template_path.read_text(encoding="utf-8")

        # フロントマター以降の本文を取得
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                body = parts[2]
            else:
                body = content
        else:
            body = content
        body = strip_leading_html_comment(body)

        # ## 〜 ###### で始まる行を抽出（レベル情報付き）
        sections: list[tuple[int, str]] = []
        for line in body.split("\n"):
            match = re.match(r"^(#{2,6})\s+(.+)$", line)
            if match:
                level = len(match.group(1))  # #の個数
                section_text = match.group(2).strip()
                sections.append((level, section_text))

        return sections
    except Exception:
        return []


def validate_sections(body: str, required_sections: list[tuple[int, str]]) -> list[str]:
    """必須セクションの存在を確認する（見出しレベルも検証）。

    Args:
        body: 投稿本文（issue / comment / pr 共通）。
        required_sections: (level, section_name) のタプルリスト。

    Returns:
        不足しているセクションの表記リスト（例: ["### Done — <サマリ>", "### Next — <サマリ>"]）。

    Note:
        em-dash 付きの見出しは「ベース名 + em-dash + サマリ」の形があるかだけを見る。
        サマリの規則（文字数・日本語・1 文）は validate_heading_summaries が見る。
        それ以外の見出しはセクション名の前方一致をチェックする。
        未編集の <placeholder> 残存は validate_body_style が見る（#962）。
    """
    missing: list[str] = []

    for level, section in required_sections:
        prefix = "#" * level

        # em-dash 付きのテンプレ見出しは「ベース名 + em-dash + サマリ」を要求
        if " — " in section:
            base = section.split(" — ", 1)[0]
            if not _find_em_dash_heading(body, prefix, base):
                missing.append(f"{prefix} {base} — <サマリ>")
            continue

        # それ以外は前方一致チェック（セクション名で始まればOK）
        pattern = rf"^{re.escape(prefix)}\s+{re.escape(section)}"
        if not re.search(pattern, body, re.MULTILINE):
            missing.append(f"{prefix} {section}")

    return missing


def validate_heading_summaries(body: str, required_sections: list[tuple[int, str]]) -> list[str]:
    """em-dash 見出しのサマリが規則（文字数・日本語・1 文）を満たすか確認する。

    Args:
        body: 投稿本文（issue / comment / pr 共通）。
        required_sections: (level, section_name) のタプルリスト。

    Returns:
        違反の表記リスト（例: ["## Verified — サマリに日本語が含まれていません"]）。
        見出し自体が無いものは validate_sections が不足として返すため、ここでは扱わない。
    """
    errors: list[str] = []
    for level, section in required_sections:
        if " — " not in section:
            continue
        prefix = "#" * level
        base = section.split(" — ", 1)[0]
        found = _find_em_dash_heading(body, prefix, base)
        if found:
            summary = found.group(1).strip()
            errors.extend(f"{prefix} {base} — {m}" for m in _summary_errors(summary))
    return errors


def _find_em_dash_heading(body: str, prefix: str, base: str) -> re.Match[str] | None:
    """「ベース名 + em-dash + サマリ」の見出しを探す（group(1) がサマリ）"""
    pattern = rf"^{re.escape(prefix)}\s+{re.escape(base)}\s+—\s+(\S.*)$"
    return re.search(pattern, body, re.MULTILINE)


def _summary_errors(summary: str) -> list[str]:
    """em-dash サマリの規則違反（文字数・日本語・1 文）を返す"""
    errors: list[str] = []
    if len(summary) > SUMMARY_MAX_CHARS:
        errors.append(f"サマリが{len(summary)}文字です（上限{SUMMARY_MAX_CHARS}文字）")
    if not _JAPANESE_CHAR_RE.search(summary):
        errors.append(SUMMARY_NOT_JAPANESE_ERROR)
    sentence = summary.rstrip(_CLOSING_BRACKETS)
    if any(ch in _SENTENCE_END_CHARS for ch in sentence[:-1]):
        errors.append(SUMMARY_MULTI_SENTENCE_ERROR)
    return errors


def _mask_fenced_code(body: str) -> tuple[list[str], bool]:
    """フェンスコードブロックの中身を空行に置き換える。

    開始フェンスはリスト配下のインデントを許し、閉じフェンスは開始と同じ文字で
    同じ長さ以上のものを探す（インデントは問わない）。

    Returns:
        (行リスト, 未閉じフェンスがあるか)
    """
    lines: list[str] = []
    fence_char = ""
    fence_len = 0

    for line in body.split("\n"):
        if not fence_char:
            match = _FENCE_RE.match(line)
            # バッククォートのフェンスは info string にバッククォートを含められない
            # （その形はインラインコードのラン）
            if match and not (match.group(2)[0] == "`" and "`" in match.group(3)):
                fence_char = match.group(2)[0]
                fence_len = len(match.group(2))
                lines.append("")
                continue
            lines.append(line)
            continue

        lines.append("")
        if re.match(rf"^[ \t]*{re.escape(fence_char)}{{{fence_len},}}[ \t]*$", line):
            fence_char = ""
            fence_len = 0

    return lines, bool(fence_char)


def _mask_inline_code(line: str) -> str:
    """インラインコードスパンを同じ長さの空白へ置換する。

    CommonMark のバッククォート・ラン規則（同じ長さのランで閉じる）に従い、
    ``` `- [ ]` ``` や二重バッククォートのスパンを検証対象から外す。
    閉じランが同一行に無い場合は暴走を避けてマスクしない。
    """
    out: list[str] = []
    pos = 0

    while True:
        opener = _BACKTICK_RUN_RE.search(line, pos)
        if opener is None:
            out.append(line[pos:])
            return "".join(out)

        run_len = len(opener.group(0))
        closer = None
        search_from = opener.end()
        while True:
            candidate = _BACKTICK_RUN_RE.search(line, search_from)
            if candidate is None:
                break
            if len(candidate.group(0)) == run_len:
                closer = candidate
                break
            search_from = candidate.end()

        if closer is None:
            out.append(line[pos : opener.end()])
            pos = opener.end()
            continue

        out.append(line[pos : opener.start()])
        out.append(" " * (closer.end() - opener.start()))
        pos = closer.end()


def _blank_keeping_newlines(text: str) -> str:
    return "".join("\n" if ch == "\n" else " " for ch in text)


def _masked_lines(body: str) -> tuple[list[str], bool]:
    """フェンス・インラインコード・HTML コメントの中身を消した行リストを返す。

    フェンス内の行は空文字になり、インラインコードと HTML コメントは同じ長さの空白になる。

    Returns:
        (マスク済みの行リスト, 未閉じフェンスがあるか)
    """
    lines, unclosed = _mask_fenced_code(body)
    masked = "\n".join(_mask_inline_code(line) for line in lines)
    masked = _HTML_COMMENT_RE.sub(lambda m: _blank_keeping_newlines(m.group(0)), masked)
    return masked.split("\n"), unclosed


_SUMMARY_HEADING_RE = re.compile(r"^ {0,3}##\s+Summary(\s|$)")
_H1_H2_RE = re.compile(r"^ {0,3}#{1,2}(\s|$)")
_IMAGE_ALT = r"(?:[^\[\]]|\[[^\[\]]*\])*"
_IMAGE_RE = re.compile(
    rf"!\[{_IMAGE_ALT}\]\([^)]+\)|!\[{_IMAGE_ALT}\]\[[^\]]*\]|<img\b", re.IGNORECASE
)


def has_summary_image(body: str) -> bool:
    """Summary セクションに画像の参照（Markdown 記法または `<img`）があるか。

    マスク後の行で探すので、フェンス・インラインコード・HTML コメント内は数えない。
    記法の網羅は目的ではなく、取りこぼしは screenshot の理由で回避できる。
    """
    lines, _ = _masked_lines(body)
    start = next((i for i, ln in enumerate(lines) if _SUMMARY_HEADING_RE.match(ln)), None)
    if start is None:
        return False
    section: list[str] = []
    for ln in lines[start + 1 :]:
        if _H1_H2_RE.match(ln):
            break
        section.append(ln)
    return bool(_IMAGE_RE.search("\n".join(section)))


def _is_horizontal_rule_tag(token: str) -> bool:
    """`<hr>` / `<hr/>` / `<hr />` か"""
    tag = _HTML_TAG_RE.match(token)
    return bool(tag and tag.group(1).lower() == "hr")


def _container_variants(line: str) -> list[str]:
    """行頭の引用 `>` とリストマーカーを 1 段ずつ剥がした行を、元の行から順に返す。

    `> ---`・`- ***`・`> - [ ] x` のように引用・リストの中に置いた水平線と
    タスクリストも GitHub は描画するため、剥がした各段で判定する。
    `- - -` のように剥がすと崩れる形があるため、剥がす前の行も残す。
    """
    variants = [line]
    current = line
    while True:
        match = _BLOCKQUOTE_PREFIX_RE.match(current) or _LIST_MARKER_PREFIX_RE.match(current)
        if match is None or match.end() == 0:
            return variants
        current = current[match.end() :]
        variants.append(current)


def _has_checkbox(line: str) -> bool:
    return any(_CHECKBOX_RE.match(v) for v in _container_variants(line))


def _has_horizontal_rule(line: str) -> bool:
    """水平線の行か、`<hr>` タグを含むか"""
    if any(_THEMATIC_BREAK_RE.match(v) for v in _container_variants(line)):
        return True
    return any(_is_horizontal_rule_tag(m.group(0)) for m in _TOKEN_RE.finditer(line))


def _has_emoji(line: str) -> bool:
    """絵文字面の文字・Emoji_Presentation の BMP 文字・U+FE0F 付きの文字・ショートコードを含むか"""
    if _EMOJI_SHORTCODE_RE.search(line):
        return True
    for index, ch in enumerate(line):
        if _EMOJI_PLANE_FIRST <= ord(ch) <= _EMOJI_PLANE_LAST:
            return True
        if ch in _EMOJI_PRESENTATION_BMP:
            return True
        if ch == _EMOJI_VARIATION_SELECTOR and index > 0:
            return True
    return False


def _is_allowed_token(token: str) -> bool:
    """`<...>` トークンが正当な記法（HTML タグ / autolink / 比較表記）か"""
    # `<hr>` は水平線規則（_has_horizontal_rule）が担当するため、ここでは許可扱い
    if _is_horizontal_rule_tag(token):
        return True
    head = token[1]
    # `<0.0.0>` `<1s>` のような比較・バージョン表現は候補から外す
    if not (head.isalpha() or head in "/!"):
        return True

    tag = _HTML_TAG_RE.match(token)
    if tag and tag.group(1).lower() in _ALLOWED_HTML_TAGS:
        return True

    return bool(_AUTOLINK_URI_RE.match(token) or _AUTOLINK_EMAIL_RE.match(token))


# 段落の続きと見なさない行の頭（見出し・リスト・表・引用・HTML タグ・画像・字下げ）
_NON_PARAGRAPH_LINE_RE = re.compile(
    r"^(#{1,6}\s|\s*([-*+]|\d+[.)])\s|\s*\||\s*>|\s*<|\s*!\[|\s{2,}\S)"
)


# 引用の行頭（`>` の段を剥がして、引用の中の段落も同じく判定する）と、GitHub の引用の種類の行（`[!WARNING]`）
_QUOTE_PREFIX_RE = re.compile(r"^\s*>\s?")
_ALERT_MARKER_RE = re.compile(r"^\[![A-Z]+\]\s*$")


def _is_paragraph_line(line: str) -> bool:
    return bool(line.strip()) and not _NON_PARAGRAPH_LINE_RE.match(line)


def _quote_level_and_text(line: str) -> tuple[int, str]:
    """行頭の `>` の段数と、剥がした後の本文を返す"""
    level = 0
    while (match := _QUOTE_PREFIX_RE.match(line)) is not None:
        level += 1
        line = line[match.end() :]
    return level, line


def _is_continued_paragraph(previous: str, line: str) -> bool:
    """同じ段の引用（段数 0 は地の文）の中で、地の文の行が続いているか"""
    previous_level, previous_text = _quote_level_and_text(previous)
    level, text = _quote_level_and_text(line)
    if previous_level != level or _ALERT_MARKER_RE.match(previous_text.strip()):
        return False
    return _is_paragraph_line(previous_text) and _is_paragraph_line(text)


def _has_soft_break(masked_lines: list[str], original_lines: list[str]) -> bool:
    """地の文の行を 2 行続けた段落があるか

    行の種類はマスク済みの行で判定し、行末の明示の改行（空白 2 つか `\\`）は元の行で判定する
    （インラインコードは空白に置き換わるため、マスク済みの行末では取り違える）。
    """
    return any(
        _is_continued_paragraph(masked_lines[index - 1], masked_lines[index])
        and not original_lines[index - 1].endswith(("  ", "\\"))
        for index in range(1, len(masked_lines))
    )


def validate_body_style(body: str) -> list[str]:
    """投稿本文に使えない記法が残っていないかを判定（#962）

    チェックボックス記法・水平線・絵文字・未編集プレースホルダ `<...>`・段落の中の改行を検出する。
    コードフェンス・インラインコード・HTML コメントの中身は対象外
    （型・比較・メタ表記はバッククォートで囲めば通る）。

    Args:
        body: 投稿本文（issue / comment / pr 共通）

    Returns:
        エラーメッセージのリスト（問題がなければ空）
    """
    masked_lines, unclosed = _masked_lines(body)
    if unclosed:
        # 何も言わずに通すとフェンス以降が丸ごと未検証になる（検証バイパス）
        return ["コードフェンスが閉じられていません"]

    errors: list[str] = []
    seen: set[str] = set()

    line_rules: tuple[tuple[str, Callable[[str], bool]], ...] = (
        (CHECKBOX_ERROR, _has_checkbox),
        (HORIZONTAL_RULE_ERROR, _has_horizontal_rule),
        (EMOJI_ERROR, _has_emoji),
    )
    for message, matches in line_rules:
        if any(matches(line) for line in masked_lines):
            errors.append(message)
    if _has_soft_break(masked_lines, body.split("\n")):
        errors.append(SOFT_BREAK_ERROR)

    for line in masked_lines:
        heading = _HEADING_RE.match(line)
        for match in _TOKEN_RE.finditer(line):
            token = match.group(0)
            if _is_allowed_token(token):
                continue
            if heading:
                message = f"{heading.group(1)} 見出しに未編集プレースホルダ {token} が残っています"
            else:
                message = f"未編集プレースホルダ {token} が残っています"
            if message in seen:
                continue
            seen.add(message)
            errors.append(message)

    return errors


def validate_fold_balance(body: str) -> list[str]:
    """折りたたみ（`<details>`）の開閉が対応しているかを判定する

    コードフェンス・インラインコード・HTML コメントの中の `<details>` は折りたたみとして
    扱わない。閉じられていない開きタグ、開きの無い閉じタグをエラーにする。
    折りたたみの外の文字数は見ない。

    未閉じのコードフェンスは空リストを返す（`validate_body_style` が別に出す）。

    Args:
        body: 投稿本文

    Returns:
        エラーメッセージのリスト（問題がなければ空）
    """
    masked_lines, unclosed = _masked_lines(body)
    if unclosed:
        return []

    depth = 0
    for masked_line in masked_lines:
        for match in _TOKEN_RE.finditer(masked_line):
            tag = _HTML_TAG_RE.match(match.group(0))
            if tag is None or tag.group(1).lower() != "details":
                continue
            depth += -1 if match.group(0).startswith("</") else 1
            if depth < 0:
                return ["<details> に対応する開きタグがありません"]

    if depth != 0:
        return ["<details> が閉じられていません"]
    return []


def validate_closed_headings(body: str, required_sections: list[tuple[int, str]]) -> list[str]:
    """テンプレに無い `##` / `###` 見出しが本文に無いかを判定する

    `(level, 名前)` の組で比べる。名前は em-dash の前の部分で、サマリは見ない。
    コードフェンス・インラインコード・HTML コメントの中の見出しは対象外で、
    `<details>` の中の見出しは対象にする。h1 と h4 以下は縛らない。

    Args:
        body: 投稿本文
        required_sections: (level, section_name) のタプルリスト（テンプレから抽出したもの）

    Returns:
        テンプレに無い見出しの表記リスト（例: ["## Context"]）。同じ見出しは 1 回だけ返す。
    """
    allowed = {(level, name.split(" — ", 1)[0].strip()) for level, name in required_sections}
    masked_lines, unclosed = _masked_lines(body)
    if unclosed:
        return []

    extra: list[str] = []
    for line in masked_lines:
        match = _CLOSED_HEADING_RE.match(line)
        if match is None:
            continue
        level = len(match.group(1))
        name = match.group(2).split(" — ", 1)[0].strip()
        if (level, name) in allowed:
            continue
        label = f"{match.group(1)} {name}"
        if label not in extra:
            extra.append(label)
    return extra


def validate_fold_summaries(body: str, expected: str) -> list[str]:
    """折りたたみの開閉部分（`<summary>`）が全て expected の形かを判定する

    コードフェンス・インラインコード・HTML コメントの中の `<summary>` は対象外。
    開きタグの位置から expected と一字一句一致するかを見るため、属性・文言・閉じタグの
    どれが違っても違反になる。

    Args:
        body: 投稿本文
        expected: `<summary>` に許す唯一の形（開きタグから閉じタグまで）

    Returns:
        エラーメッセージのリスト（問題がなければ空）
    """
    masked_lines, unclosed = _masked_lines(body)
    if unclosed:
        return []

    errors: list[str] = []
    for masked_line in masked_lines:
        for match in _TOKEN_RE.finditer(masked_line):
            token = match.group(0)
            tag = _HTML_TAG_RE.match(token)
            if tag is None or tag.group(1).lower() != "summary" or token.startswith("</"):
                continue
            if masked_line.startswith(expected, match.start()):
                continue
            message = f"{masked_line.strip()} は {expected} にしてください"
            if message not in errors:
                errors.append(message)
    return errors


__all__ = [
    "CHECKBOX_ERROR",
    "CLOSED_HEADINGS_BY_TEMPLATE",
    "EMOJI_ERROR",
    "FOLD_SUMMARY_BY_TEMPLATE",
    "HORIZONTAL_RULE_ERROR",
    "PLAN_FOLD_SUMMARY",
    "SUMMARY_MAX_CHARS",
    "SUMMARY_MULTI_SENTENCE_ERROR",
    "SUMMARY_NOT_JAPANESE_ERROR",
    "extract_sections_from_template",
    "validate_body_style",
    "validate_closed_headings",
    "validate_fold_balance",
    "validate_fold_summaries",
    "validate_heading_summaries",
    "validate_sections",
]
