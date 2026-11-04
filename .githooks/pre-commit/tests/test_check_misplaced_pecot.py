"""check-misplaced-pecot.sh のユニットテスト。

リポジトリルート以外に残存する .pecot/ ディレクトリ（untracked 含む）を find 走査で
検知し、exit 1 でブロックするチェックを検証する。git_repo fixture が生成する temp repo を
PROJECT_DIR（git rev-parse --show-toplevel の解決先）として使う。
"""

from __future__ import annotations

import stat
from pathlib import Path


def test_nested_pecot_blocks(script_dir: Path, git_repo, run_script) -> None:
    """(a) パッケージ配下のネスト .pecot/ あり → exit 1・検出パスと対処案内を表示。"""
    repo = git_repo()
    misplaced = repo / "pkg" / ".pecot" / "work" / "1"
    misplaced.mkdir(parents=True)
    (misplaced / "scratch.txt").write_text("x")

    result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)

    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert str(repo / "pkg" / ".pecot") in out
    assert ".pecot/work/<Issue番号>/" in out


def test_root_pecot_only_passes(script_dir: Path, git_repo, run_script) -> None:
    """(b) ルート直下の正規 .pecot/ のみ → exit 0（配下の残骸も prune で誤検知しない）。"""
    repo = git_repo()
    # ルート正規 .pecot/ 配下に work 残骸内の fixture 由来 .pecot を置いても prune される
    nested = repo / ".pecot" / "work" / "2" / "fixture" / ".pecot"
    nested.mkdir(parents=True)

    result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)

    assert result.returncode == 0


def test_node_modules_pecot_passes(script_dir: Path, git_repo, run_script) -> None:
    """(c) node_modules/ 配下の .pecot → prune で除外され exit 0。"""
    repo = git_repo()
    (repo / "node_modules" / "somepkg" / ".pecot").mkdir(parents=True)

    result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)

    assert result.returncode == 0


def test_unreadable_dir_without_misplaced_passes(script_dir: Path, git_repo, run_script) -> None:
    """(d) 読み取り不能ディレクトリ (chmod 000) があっても誤配置がなければ exit 0。

    F-01 の回帰テスト。`set -euo pipefail` 下で find が exit 1 を返しても
    2>/dev/null || true で握りつぶし、案内文なしの誤ブロックを防ぐ。
    teardown で必ず chmod を戻す（戻さないと tmp_path の後片付けが失敗する）。
    """
    repo = git_repo()
    locked = repo / "locked"
    locked.mkdir()
    locked.chmod(0o000)
    try:
        result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)
    finally:
        locked.chmod(stat.S_IRWXU)

    assert result.returncode == 0


def test_multiple_misplaced_all_listed(script_dir: Path, git_repo, run_script) -> None:
    """(e) 2 箇所以上の同時誤配置 → 全件がメッセージに列挙され exit 1。"""
    repo = git_repo()
    first = repo / "pkgA" / ".pecot"
    second = repo / "pkgB" / "nested" / ".pecot"
    first.mkdir(parents=True)
    second.mkdir(parents=True)

    result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)

    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert str(first) in out
    assert str(second) in out


def test_nested_misplaced_reports_top_only(script_dir: Path, git_repo, run_script) -> None:
    """(f) 誤配置 .pecot 配下に入れ子 .pecot → トップ 1 件のみ報告。

    F-03 の回帰テスト。find 式の `-print -prune` により、検出した .pecot 自身を
    prune してその配下の入れ子 .pecot を二重報告しない。
    """
    repo = git_repo()
    top = repo / "pkg" / ".pecot"
    inner = top / "work" / "1" / ".pecot"
    inner.mkdir(parents=True)

    result = run_script(script_dir / "check-misplaced-pecot.sh", cwd=repo)

    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert str(top) in out
    assert str(inner) not in out
