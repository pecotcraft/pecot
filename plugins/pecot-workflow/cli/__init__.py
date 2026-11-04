"""pecot - pecot-workflow プラグイン本体（バックエンド Python CLI）。

Claude Code / Copilot CLI のスキル経由および直接 uvx 実行の両方から利用される。
"""

import json
import os
from pathlib import Path
from typing import cast


def _read_version() -> str:
    """version を 3 段 fallback で解決する。

    1. CLAUDE_PLUGIN_ROOT env 経由の plugin.json
    2. __file__ 相対の plugin.json
       (cli/__init__.py → parents[1] = プラグインのルート)
    3. "0.0.0+dev"

    導入先の CLI はデータ置き場の非 editable な venv で動くため、``__file__`` はプラグインの外を指し、
    手順 2 では plugin.json が見つからない。bin/pecot が CLAUDE_PLUGIN_ROOT を export して手順 1 に乗せる。
    手順 2 はソースツリーから直接動かすとき（テスト・開発）のための fallback。
    両方失敗時は 0.0.0+dev を返す。
    """
    # --- 手順 1: CLAUDE_PLUGIN_ROOT env ---
    root = (os.environ.get("CLAUDE_PLUGIN_ROOT") or "").strip()
    if root:
        version = _load_version_from_plugin_json(Path(root, ".claude-plugin/plugin.json"))
        if version is not None:
            return version

    # --- 手順 2: __file__ 相対 ---
    # ソースツリーで直接動かすときだけ当たる。
    # __file__ = plugins/pecot-workflow/cli/__init__.py
    # parents[1] = plugins/pecot-workflow
    try:
        source_relative = Path(__file__).resolve().parents[1] / ".claude-plugin/plugin.json"
    except (AttributeError, IndexError):
        source_relative = None
    if source_relative is not None:
        version = _load_version_from_plugin_json(source_relative)
        if version is not None:
            return version

    return "0.0.0+dev"


def _load_version_from_plugin_json(path: Path) -> str | None:
    """path の plugin.json から version 文字列を読み返す。読めない場合は None。"""
    try:
        parsed: object = json.loads(path.read_text())
        if not isinstance(parsed, dict):
            return None
        data = cast("dict[str, object]", parsed)
        version: object = data.get("version")
        if isinstance(version, str) and version:
            return version
    except (OSError, ValueError, AttributeError):
        pass
    return None


__version__ = _read_version()
