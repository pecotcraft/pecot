"""tests/core/test_ref_parser.py - ref_parser.py のユニットテスト

contracts/core-ref-parser.md §テスト観点との対応表（観点 → 対応テスト）:

1. 主軸形式 ``owner/repo/N`` 正常 → TestParseIssueRef.test_full_new_format。
2. 短縮形 ``N`` + base_repo → TestParseIssueRef.test_shorthand_with_base_repo。
3. 短縮形 ``N`` + base欠落→RefParseError → TestParseIssueRef.test_shorthand_without_base_raises。
4. 特殊文字（ハイフン/_/.） → TestParseIssueRef.test_full_new_format_with_hyphen 等。
5. ``#5`` 拒否 → TestParseIssueRef.test_hash_only_rejected。
6. ``owner/repo/abc`` 拒否 → TestParseIssueRef.test_full_format_non_numeric_rejected。
7. ``owner//5`` 拒否 → TestParseIssueRef.test_empty_repo_segment_rejected。
8. 既存呼出互換（フル形式に base なし） → TestParseIssueRef.test_full_format_without_base。

``parse_pr_ref`` は ``parse_issue_ref`` への委譲であり、代表ケースのみ確認する。
``parse_repo_ref`` は ``RepoRef`` を返す。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from cli.core.ref_parser import (
    IssueRef,
    RefParseError,
    extract_refs_issue_numbers,
    parse_issue_ref,
    parse_pr_ref,
    parse_repo_ref,
)
from cli.core.repo_resolver import RepoRef

# parse_issue_ref (contract §Public API)


class TestParseIssueRef:
    """parse_issue_ref(raw, base_repo=None) -> IssueRef"""

    # ---- 主軸形式 ----

    def test_full_new_format(self) -> None:
        ref = parse_issue_ref("owner/repo/123")
        assert ref.repo.full_name == "owner/repo"
        assert ref.number == 123

    def test_full_new_format_with_hyphen(self) -> None:
        ref = parse_issue_ref("my-org/my-repo/456")
        assert ref.repo.owner == "my-org"
        assert ref.repo.repo == "my-repo"
        assert ref.number == 456

    def test_full_new_format_with_underscore(self) -> None:
        ref = parse_issue_ref("my_org/my_repo/789")
        assert ref.repo.owner == "my_org"
        assert ref.repo.repo == "my_repo"

    def test_full_new_format_with_dot(self) -> None:
        ref = parse_issue_ref("owner/repo.name/123")
        assert ref.repo.repo == "repo.name"

    def test_full_format_without_base(self) -> None:
        """既存呼出互換: base_repo なしでも主軸形式は受理される。"""
        ref = parse_issue_ref("owner/repo/5")
        assert ref.repo.full_name == "owner/repo"
        assert ref.number == 5

    def test_full_new_format_ignores_base_repo(self) -> None:
        """主軸形式があれば base_repo は無視される（REF 側が勝つ）。"""
        base = RepoRef(owner="other", repo="repo")
        ref = parse_issue_ref("owner/repo/456", base_repo=base)
        assert ref.repo.owner == "owner"
        assert ref.repo.repo == "repo"

    # ---- 短縮形 ----

    def test_shorthand_with_base_repo(self) -> None:
        base = RepoRef(owner="o", repo="r")
        ref = parse_issue_ref("123", base_repo=base)
        assert ref.repo == base
        assert ref.number == 123

    def test_shorthand_without_base_raises(self) -> None:
        with pytest.raises(RefParseError) as exc_info:
            parse_issue_ref("123")
        assert exc_info.value.ref == "123"

    def test_shorthand_without_base_points_to_full_form_only(self) -> None:
        with pytest.raises(RefParseError) as exc_info:
            parse_issue_ref("123")
        assert exc_info.value.message == (
            "the short form 'N' is not accepted here: use the full form 'owner/repo/N'"
        )

    def test_shorthand_without_base_points_to_repo_flag(self) -> None:
        with pytest.raises(RefParseError) as exc_info:
            parse_issue_ref("123", repo_flag=True)
        assert exc_info.value.message == (
            "the short form 'N' needs a base_repo: "
            "pass --repo <owner/repo> or use the full form 'owner/repo/N'"
        )

    def test_shorthand_rejects_unicode_digits(self) -> None:
        """str.isdigit() は全角/丸数字にも True を返すので ASCII 限定のこと。"""
        base = RepoRef(owner="o", repo="r")
        with pytest.raises(RefParseError):
            parse_issue_ref("１２３", base_repo=base)
        with pytest.raises(RefParseError):
            parse_issue_ref("①", base_repo=base)

    # ---- 拒否ケース ----

    def test_hash_only_rejected(self) -> None:
        """``#5`` は形式不正（owner/repo 情報なし、短縮形でもない）。"""
        with pytest.raises(RefParseError):
            parse_issue_ref("#5")

    def test_full_format_non_numeric_rejected(self) -> None:
        """``owner/repo/abc`` は数字でないので拒否。"""
        with pytest.raises(RefParseError):
            parse_issue_ref("owner/repo/abc")

    def test_empty_repo_segment_rejected(self) -> None:
        """``owner//5`` のような空セグメントは RefParseError で拒否される。"""
        with pytest.raises(RefParseError):
            parse_issue_ref("owner//5")

    def test_invalid_format_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_issue_ref("not-a-valid-ref")

    def test_error_contains_ref(self) -> None:
        with pytest.raises(RefParseError) as exc_info:
            parse_issue_ref("invalid")
        assert exc_info.value.ref == "invalid"

    def test_invalid_format_error_message_lists_accepted_forms(self) -> None:
        """不正形式のエラーメッセージにaccepted forms 2 種類が列挙され、``owner/repo#N`` は含まれないこと。"""
        with pytest.raises(RefParseError) as exc_info:
            parse_issue_ref("owner//5")
        msg = exc_info.value.message
        assert "accepted forms" in msg
        assert "owner/repo/N" in msg
        assert "N' (with a base repository)" in msg
        assert "owner/repo#N" not in msg

    def test_old_format_incomplete_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_issue_ref("owner/repo#")

    def test_old_format_non_numeric_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_issue_ref("owner/repo#abc")


# parse_pr_ref (contract §Public API、parse_issue_ref への委譲)


class TestParsePRRef:
    """parse_pr_ref(raw, base_repo=None) -> IssueRef"""

    def test_full_new_format(self) -> None:
        ref = parse_pr_ref("owner/repo/456")
        assert ref.repo.full_name == "owner/repo"
        assert ref.number == 456

    def test_shorthand_with_base_repo(self) -> None:
        base = RepoRef(owner="o", repo="r")
        ref = parse_pr_ref("7", base_repo=base)
        assert ref.repo == base
        assert ref.number == 7

    def test_invalid_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_pr_ref("invalid-format")


# parse_repo_ref (contract §Public API)


class TestParseRepoRef:
    """parse_repo_ref(raw) -> RepoRef"""

    def test_valid(self) -> None:
        ref = parse_repo_ref("owner/repo")
        assert isinstance(ref, RepoRef)
        assert ref.owner == "owner"
        assert ref.repo == "repo"

    def test_hyphen_in_names(self) -> None:
        ref = parse_repo_ref("my-org/my-repo")
        assert ref.owner == "my-org"
        assert ref.repo == "my-repo"

    def test_dot_in_repo(self) -> None:
        ref = parse_repo_ref("owner/repo.name")
        assert ref.repo == "repo.name"

    def test_three_segments_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_repo_ref("owner/repo/123")

    def test_no_slash_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_repo_ref("ownerrepo")

    def test_empty_string_rejected(self) -> None:
        with pytest.raises(RefParseError):
            parse_repo_ref("")


# IssueRef pydantic モデル（data-model.md §IssueRef 準拠）


class TestIssueRef:
    """IssueRef モデル自体のバリデーション。"""

    def test_str_representation(self) -> None:
        ref = IssueRef(repo=RepoRef(owner="o", repo="r"), number=42)
        assert str(ref) == "o/r#42"

    def test_to_cli_ref(self) -> None:
        ref = IssueRef(repo=RepoRef(owner="o", repo="r"), number=42)
        assert ref.to_cli_ref() == "o/r/42"

    def test_number_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            IssueRef(repo=RepoRef(owner="o", repo="r"), number=0)

    def test_number_must_not_be_negative(self) -> None:
        with pytest.raises(ValidationError):
            IssueRef(repo=RepoRef(owner="o", repo="r"), number=-1)

    def test_nested_repo_validation(self) -> None:
        with pytest.raises(ValidationError):
            IssueRef(repo={"owner": "bad owner", "repo": "r"}, number=1)


_PR_REPO = RepoRef(owner="acme-labs", repo="aist-plugin")


class TestExtractRefsIssueNumbers:
    """extract_refs_issue_numbers のテスト"""

    def test_single_refs(self) -> None:
        assert extract_refs_issue_numbers("変更内容\n\nRefs #935", _PR_REPO) == {935}

    def test_multiple_refs(self) -> None:
        assert extract_refs_issue_numbers("Refs #100\nRefs #200", _PR_REPO) == {100, 200}

    def test_ref_singular(self) -> None:
        assert extract_refs_issue_numbers("Ref #42", _PR_REPO) == {42}

    def test_case_insensitive(self) -> None:
        assert extract_refs_issue_numbers("refs #10", _PR_REPO) == {10}

    def test_no_refs(self) -> None:
        assert extract_refs_issue_numbers("本文のみ", _PR_REPO) == set()

    def test_none_body(self) -> None:
        assert extract_refs_issue_numbers(None, _PR_REPO) == set()

    def test_empty_body(self) -> None:
        assert extract_refs_issue_numbers("", _PR_REPO) == set()

    def test_fixes_not_matched(self) -> None:
        """Fixes/Closesはマッチしない（closingIssuesReferencesが担当）"""
        assert extract_refs_issue_numbers("Fixes #123", _PR_REPO) == set()

    def test_inline_refs(self) -> None:
        """文中のRefs"""
        assert extract_refs_issue_numbers("この変更は Refs #55 に関連", _PR_REPO) == {55}

    def test_word_boundary_required(self) -> None:
        """Refs の直前が空白・行頭でなければマッチしない"""
        assert extract_refs_issue_numbers("xRefs #7", _PR_REPO) == set()

    def test_colon_form(self) -> None:
        assert extract_refs_issue_numbers("Refs: #171", _PR_REPO) == {171}

    def test_colon_form_with_trailing_text(self) -> None:
        assert extract_refs_issue_numbers("Refs: #251 (Epic: #43)", _PR_REPO) == {251}

    def test_same_repo_hash_form(self) -> None:
        body = "Refs: acme-labs/aist-plugin#227"
        assert extract_refs_issue_numbers(body, _PR_REPO) == {227}

    def test_same_repo_slash_form(self) -> None:
        body = "Refs acme-labs/aist-plugin/228"
        assert extract_refs_issue_numbers(body, _PR_REPO) == {228}

    def test_same_repo_casefold(self) -> None:
        body = "Refs ACme-labs/AIST-Plugin#9"
        assert extract_refs_issue_numbers(body, _PR_REPO) == {9}

    def test_other_repo_ignored(self) -> None:
        body = "Refs acme-labs/pecot-presentation#264\nRefs other/aist-plugin/5"
        assert extract_refs_issue_numbers(body, _PR_REPO) == set()

    def test_mixed_forms(self) -> None:
        body = (
            "Refs #1\nRef: acme-labs/aist-plugin#2\nRefs other/repo#3\nrefs acme-labs/aist-plugin/4"
        )
        assert extract_refs_issue_numbers(body, _PR_REPO) == {1, 2, 4}

    def test_bare_number_not_matched(self) -> None:
        """# と owner/repo のどちらも無い番号は拾わない"""
        assert extract_refs_issue_numbers("Refs 12", _PR_REPO) == set()
