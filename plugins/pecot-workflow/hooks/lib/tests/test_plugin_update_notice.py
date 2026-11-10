"""plugin-update-notice.sh のユニットテスト（test_plugin_update_notice.bats 移植）。

インストール済みプラグインと marketplace clone 最新版の version 乖離を検知し、installed が
古い場合のみ更新案内を出すことを検証する。フィクスチャ木を構築して CLAUDE_PLUGIN_ROOT を
指す（bats _make_fixture 相当）。
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def notice_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "session-start"
        / "plugin-update-notice.sh"
    )


@pytest.fixture
def no_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """hooks-config.json 不在前提（既定値 true で有効）に固定する。"""
    path = tmp_path / "no-such-hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(path))
    return path


# プラグイン名 → リポ内の dir 名。
_PLUGIN_DIRS = {"pecot-w": "pecot-workflow", "pecot-v": "pecot-visual"}


@pytest.fixture
def make_fixture(tmp_path: Path) -> Callable[..., Path]:
    """installed/latest の version 木を構築し ROOT を返す（bats _make_fixture 相当）。

    latest を空文字にすると clone 側 plugin.json を生成しない（clone 不在の再現）。
    claude 形は、<plugins ルート>/cache/<mp>/<name>/<ver> と兄弟の marketplaces、known_marketplaces.json を作る。
    plugins_root で、標準（~/.claude/plugins）以外のルートを指す。
    標準以外のルートは、CLAUDE_CONFIG_DIR・CLAUDE_CODE_PLUGIN_CACHE_DIR・cowork_plugins 相当。
    copilot 形の clone は、copilot_cache=True なら Copilot 自身のキャッシュに置く。
    キャッシュは <home>/.cache/copilot/marketplaces/<スラッグ>。
    False なら Claude Code 側の clone に置く。
    """
    home = tmp_path / "home"

    def _make(
        installed: str,
        latest: str,
        flavor: str,
        mp: str = "pecot",
        name: str = "pecot-w",
        source: object = "default",
        plugins_root: Path | None = None,
        known_marketplaces: bool = True,
        install_location: Path | None = None,
        copilot_cache: bool = False,
    ) -> Path:
        claude_plugins = plugins_root or home / ".claude" / "plugins"
        if flavor == "claude":
            root = claude_plugins / "cache" / mp / name / installed
            clone_dir = claude_plugins / "marketplaces" / mp
        elif flavor == "copilot":
            root = home / ".copilot" / "installed-plugins" / mp / name
            if copilot_cache:
                clone_dir = (
                    home
                    / ".copilot"
                    / ".cache"
                    / "copilot"
                    / "marketplaces"
                    / "https---example-com-o-r-git"
                )
            else:
                clone_dir = claude_plugins / "marketplaces" / mp
        else:
            raise ValueError(f"unknown flavor: {flavor}")
        # dir 名とプラグイン名は一致しない。marketplace.json の source が clone 内の場所を決める。
        plugin_dir = _PLUGIN_DIRS[name]
        if install_location is not None:
            clone_dir = install_location
        clone_root = clone_dir / "plugins" / plugin_dir
        if source == "default":
            source = f"./plugins/{plugin_dir}"

        (root / ".claude-plugin").mkdir(parents=True)
        (root / ".claude-plugin" / "plugin.json").write_text(f'{{"version":"{installed}"}}\n')
        if flavor == "claude" and known_marketplaces:
            entry = {"installLocation": str(install_location or clone_dir)}
            (claude_plugins / "known_marketplaces.json").write_text(json.dumps({mp: entry}))

        if latest:
            (clone_dir / ".claude-plugin").mkdir(parents=True)
            (clone_dir / ".claude-plugin" / "marketplace.json").write_text(
                json.dumps({"name": mp, "plugins": [{"name": name, "source": source}]})
            )
            (clone_root / ".claude-plugin").mkdir(parents=True)
            (clone_root / ".claude-plugin" / "plugin.json").write_text(
                f'{{"version":"{latest}"}}\n'
            )
        return root

    return _make


def _run_notice(
    notice_script: Path,
    *,
    plugin_root: str | None,
    config_path: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    env = {**os.environ}
    env.pop("CLAUDE_CONFIG_DIR", None)
    env.pop("CLAUDE_CODE_PLUGIN_CACHE_DIR", None)
    env.update(extra_env or {})
    if plugin_root is None:
        env.pop("CLAUDE_PLUGIN_ROOT", None)
    else:
        env["CLAUDE_PLUGIN_ROOT"] = plugin_root
    if config_path is not None:
        env["PECOT_HOOKS_CONFIG_PATH"] = config_path
    return subprocess.run(
        [str(notice_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


def test_claude_installed_older_outputs_notice(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert "installed: 1.2.0" in result.stdout
    assert "plugin update available: " in result.stdout
    assert " 1.3.0 (installed:" in result.stdout
    assert "claude plugin update pecot-w@pecot" in result.stdout
    assert "-s project" in result.stdout


def test_claude_version_match_no_output(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.3.0", "1.3.0", "claude")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_installed_newer_no_output(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.4.0", "1.3.0", "claude")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_copilot_installed_older_outputs_notice(
    notice_script, make_fixture, no_config_path
) -> None:
    root = make_fixture("1.2.0", "1.3.0", "copilot", "pecot", "pecot-v")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert "copilot plugin update pecot-v@pecot" in result.stdout
    assert "installed: 1.2.0" in result.stdout
    assert "plugin update available: " in result.stdout
    assert " 1.3.0 (installed:" in result.stdout
    # copilot 形では -s project の注記は付かない。
    assert "-s project" not in result.stdout


def test_plugin_root_unset_no_output(notice_script, no_config_path) -> None:
    result = _run_notice(notice_script, plugin_root=None)
    assert result.returncode == 0
    assert result.stdout == ""


def test_dev_path_no_output(notice_script, tmp_path, no_config_path) -> None:
    root = tmp_path / "dev" / "aist-plugin" / "plugins" / "pecot-workflow"
    (root / ".claude-plugin").mkdir(parents=True)
    (root / ".claude-plugin" / "plugin.json").write_text('{"version":"1.2.0"}\n')
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_marketplace_clone_absent_no_output(notice_script, make_fixture, no_config_path) -> None:
    # latest を空にして clone 側 plugin.json を生成しない。
    root = make_fixture("1.2.0", "", "claude")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_installed_version_missing_no_output(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    # installed 側 plugin.json を version 欠落に差し替え。
    (root / ".claude-plugin" / "plugin.json").write_text("{}\n")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_disabled_via_config_no_output(notice_script, make_fixture, tmp_path) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    config = tmp_path / "hooks-config.json"
    config.write_text('{"plugin-update-notice": false}')
    result = _run_notice(notice_script, plugin_root=str(root), config_path=str(config))
    assert result.returncode == 0
    assert result.stdout == ""


def test_trailing_slash_root_detected(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    result = _run_notice(notice_script, plugin_root=f"{root}/")
    assert result.returncode == 0
    assert "claude plugin update pecot-w@pecot" in result.stdout


def test_wiring_via_session_start_common(
    notice_script, make_fixture, no_config_path, tmp_path, project_root
) -> None:
    """配線 — session-start-common.sh 経由で通知が注入される。

    session-start-common.sh は git-sync / vscode-detector 等も動くため、env を隔離する。
    CLAUDE_PROJECT_DIR を .pecot 不在の dir に向け、CLAUDE_ENV_FILE を unset にする。
    GIT_* は、conftest の autouse 隔離に委譲する。
    """
    root = make_fixture("1.2.0", "1.3.0", "claude")
    project_dir = tmp_path / "plain-project"
    project_dir.mkdir(parents=True)
    common_script = (
        project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "session-start-common.sh"
    )
    env = {**os.environ}
    env.pop("CLAUDE_ENV_FILE", None)
    env["CLAUDE_PROJECT_DIR"] = str(project_dir)
    env["CLAUDE_PLUGIN_ROOT"] = str(root)
    result = subprocess.run(
        [str(common_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )
    assert result.returncode == 0
    assert "plugin update available: pecot-w" in result.stdout
    assert "claude plugin update pecot-w@pecot" in result.stdout


def test_dir_name_differs_from_plugin_name(notice_script, make_fixture, no_config_path) -> None:
    """pecot-w の clone 側は plugins/pecot-workflow にあり、source 経由で latest を引ける。"""
    root = make_fixture("1.2.0", "2.0.0", "claude", "pecot", "pecot-w")
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert "plugin update available: " in result.stdout
    assert " 2.0.0 (installed:" in result.stdout
    assert "claude plugin update pecot-w@pecot" in result.stdout


def test_marketplace_source_mismatch_no_output(notice_script, make_fixture, no_config_path) -> None:
    """marketplace.json に同名項目が無い（source 不一致）なら skip。"""
    root = make_fixture("1.2.0", "1.3.0", "claude", "pecot", "pecot-w")
    marketplace = root.parents[3] / "marketplaces" / "pecot" / ".claude-plugin" / "marketplace.json"
    marketplace.write_text(json.dumps({"plugins": [{"name": "other", "source": "./plugins/x"}]}))
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def test_marketplace_object_source_no_output(notice_script, make_fixture, no_config_path) -> None:
    """source がオブジェクト形式（github 等）なら読めないため skip。"""
    root = make_fixture(
        "1.2.0",
        "1.3.0",
        "claude",
        "pecot",
        "pecot-w",
        source={"source": "github", "repo": "a/b"},
    )
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert result.stdout == ""


def _assert_claude_notice(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0
    assert "installed: 1.2.0" in result.stdout
    assert "plugin update available: " in result.stdout
    assert " 1.3.0 (installed:" in result.stdout
    assert "claude plugin update pecot-w@pecot" in result.stdout


def _assert_silent(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_custom_config_dir_outputs_notice(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    """CLAUDE_CONFIG_DIR を既定以外にした利用者（#1236）。環境変数は読まず ROOT から導出する。"""
    config_dir = tmp_path / "custom-claude-config"
    root = make_fixture("1.2.0", "1.3.0", "claude", plugins_root=config_dir / "plugins")
    result = _run_notice(
        notice_script, plugin_root=str(root), extra_env={"CLAUDE_CONFIG_DIR": str(config_dir)}
    )
    _assert_claude_notice(result)


def test_claude_custom_config_dir_with_trailing_slash(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    config_dir = tmp_path / "custom-claude-config"
    root = make_fixture("1.2.0", "1.3.0", "claude", plugins_root=config_dir / "plugins")
    result = _run_notice(
        notice_script,
        plugin_root=f"{root}/",
        extra_env={"CLAUDE_CONFIG_DIR": f"{config_dir}/"},
    )
    _assert_claude_notice(result)


def test_claude_default_dir_still_works_when_config_dir_differs(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    result = _run_notice(
        notice_script,
        plugin_root=str(root),
        extra_env={"CLAUDE_CONFIG_DIR": str(tmp_path / "other")},
    )
    _assert_claude_notice(result)


def test_claude_plugin_cache_dir_layout_outputs_notice(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    """CLAUDE_CODE_PLUGIN_CACHE_DIR でルートを変えた配置（.claude を含まないパス）。"""
    cache_root = tmp_path / "elsewhere" / "plugin-root"
    root = make_fixture("1.2.0", "1.3.0", "claude", plugins_root=cache_root)
    result = _run_notice(
        notice_script,
        plugin_root=str(root),
        extra_env={"CLAUDE_CODE_PLUGIN_CACHE_DIR": str(cache_root)},
    )
    _assert_claude_notice(result)


def test_claude_cowork_plugins_layout_outputs_notice(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    root = make_fixture(
        "1.2.0", "1.3.0", "claude", plugins_root=tmp_path / "home" / ".claude" / "cowork_plugins"
    )
    _assert_claude_notice(_run_notice(notice_script, plugin_root=str(root)))


def test_claude_install_location_used_when_clone_elsewhere(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    """known_marketplaces.json の installLocation が既定の marketplaces/<mp> と違う場合はそちらを読む。"""
    root = make_fixture(
        "1.2.0", "1.3.0", "claude", install_location=tmp_path / "somewhere" / "clone"
    )
    _assert_claude_notice(_run_notice(notice_script, plugin_root=str(root)))


def test_claude_install_location_missing_dir_falls_back_to_sibling(
    notice_script, make_fixture, no_config_path
) -> None:
    root = make_fixture("1.2.0", "1.3.0", "claude")
    plugins = root.parents[3]
    (plugins / "known_marketplaces.json").write_text(
        json.dumps({"pecot": {"installLocation": "/nonexistent/clone"}})
    )
    _assert_claude_notice(_run_notice(notice_script, plugin_root=str(root)))


def test_claude_without_known_marketplaces_no_output(
    notice_script, make_fixture, no_config_path
) -> None:
    """plugins ルートに known_marketplaces.json が無い（dev パスとの区別）なら skip。"""
    root = make_fixture("1.2.0", "1.3.0", "claude", known_marketplaces=False)
    _assert_silent(_run_notice(notice_script, plugin_root=str(root)))


def test_claude_root_too_shallow_no_output(notice_script, make_fixture, no_config_path) -> None:
    """ROOT が cache/<mp>/<name> までで版 dir が無い → skip。"""
    root = make_fixture("1.2.0", "1.3.0", "claude")
    _assert_silent(_run_notice(notice_script, plugin_root=str(root.parent)))


def test_claude_root_too_deep_no_output(notice_script, make_fixture, no_config_path) -> None:
    """ROOT が版 dir の下の階層を指す（cache が 3 階層上でない）→ skip。"""
    root = make_fixture("1.2.0", "1.3.0", "claude")
    sub = root / "sub"
    (sub / ".claude-plugin").mkdir(parents=True)
    (sub / ".claude-plugin" / "plugin.json").write_text('{"version":"1.2.0"}\n')
    _assert_silent(_run_notice(notice_script, plugin_root=str(sub)))


def test_claude_cache_named_dir_in_dev_path_no_output(
    notice_script, tmp_path, no_config_path
) -> None:
    """dev パスの途中に cache という名の dir があっても known_marketplaces.json が無ければ skip。"""
    root = tmp_path / "dev" / "cache" / "aist-plugin" / "plugins" / "pecot-workflow"
    (root / ".claude-plugin").mkdir(parents=True)
    (root / ".claude-plugin" / "plugin.json").write_text('{"version":"1.2.0"}\n')
    _assert_silent(_run_notice(notice_script, plugin_root=str(root)))


def test_copilot_reads_clone_under_custom_config_dir(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    """Copilot のキャッシュが無ければ CLAUDE_CONFIG_DIR 下の Claude Code 側 clone を読む。"""
    config_dir = tmp_path / "custom-claude-config"
    root = make_fixture(
        "1.2.0", "1.3.0", "copilot", "pecot", "pecot-v", plugins_root=config_dir / "plugins"
    )
    result = _run_notice(
        notice_script, plugin_root=str(root), extra_env={"CLAUDE_CONFIG_DIR": str(config_dir)}
    )
    assert result.returncode == 0
    assert "copilot plugin update pecot-v@pecot" in result.stdout
    assert "plugin update available: " in result.stdout
    assert " 1.3.0 (installed:" in result.stdout


def test_copilot_reads_own_marketplace_cache(notice_script, make_fixture, no_config_path) -> None:
    """Copilot 単独環境（Claude Code 側の clone なし）でも Copilot のキャッシュから最新版を引く。"""
    root = make_fixture("1.2.0", "1.3.0", "copilot", "pecot", "pecot-v", copilot_cache=True)
    result = _run_notice(notice_script, plugin_root=str(root))
    assert result.returncode == 0
    assert "copilot plugin update pecot-v@pecot" in result.stdout
    assert "installed: 1.2.0" in result.stdout
    assert "plugin update available: " in result.stdout
    assert " 1.3.0 (installed:" in result.stdout


def test_copilot_cache_preferred_over_claude_clone(
    notice_script, make_fixture, no_config_path, tmp_path
) -> None:
    """両方ある場合は Copilot 自身のキャッシュ（1.4.0）を優先する。"""
    root = make_fixture("1.2.0", "1.4.0", "copilot", "pecot", "pecot-v", copilot_cache=True)
    claude_clone = tmp_path / "home" / ".claude" / "plugins" / "marketplaces" / "pecot"
    (claude_clone / ".claude-plugin").mkdir(parents=True)
    (claude_clone / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "pecot",
                "plugins": [{"name": "pecot-v", "source": "./plugins/pecot-visual"}],
            }
        )
    )
    plugin_json = claude_clone / "plugins" / "pecot-visual" / ".claude-plugin"
    plugin_json.mkdir(parents=True)
    (plugin_json / "plugin.json").write_text('{"version":"1.3.0"}\n')
    result = _run_notice(notice_script, plugin_root=str(root))
    assert "plugin update available: " in result.stdout
    assert " 1.4.0 (installed:" in result.stdout


def test_copilot_cache_of_other_marketplace_ignored(
    notice_script, make_fixture, no_config_path
) -> None:
    """キャッシュ内の marketplace.json の name が mp と違えば使わない（skip）。"""
    root = make_fixture("1.2.0", "1.3.0", "copilot", "pecot", "pecot-v", copilot_cache=True)
    cache = root.parents[2] / ".cache" / "copilot" / "marketplaces" / "https---example-com-o-r-git"
    manifest = cache / ".claude-plugin" / "marketplace.json"
    manifest.write_text(
        json.dumps(
            {"name": "other", "plugins": [{"name": "pecot-v", "source": "./plugins/pecot-visual"}]}
        )
    )
    _assert_silent(_run_notice(notice_script, plugin_root=str(root)))


def test_copilot_without_any_clone_no_output(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.2.0", "", "copilot", "pecot", "pecot-v")
    _assert_silent(_run_notice(notice_script, plugin_root=str(root)))


def test_copilot_root_too_deep_no_output(notice_script, make_fixture, no_config_path) -> None:
    root = make_fixture("1.2.0", "1.3.0", "copilot", "pecot", "pecot-v", copilot_cache=True)
    sub = root / "sub"
    (sub / ".claude-plugin").mkdir(parents=True)
    _assert_silent(_run_notice(notice_script, plugin_root=str(sub)))
