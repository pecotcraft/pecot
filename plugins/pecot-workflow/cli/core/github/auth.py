"""GitHub トークン解決に使うホスト設定と .env の読み書き。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, cast

from cli.core.config import get_config_dir
from cli.core.paths import get_project_root as get_project_root


def as_dict(value: Any) -> dict[str, Any]:
    """GraphQL/REST の動的レスポンス断片を ``dict[str, Any]`` に正規化する。

    httpx ``Response.json()`` / gql ``.execute()`` 由来の値は ``Any`` 型になる。
    ``value or {}`` のような式は pyright strict 下で ``dict[Unknown, Unknown]`` に崩れる。
    これが Unknown カスケードの起点になる。
    ``dict`` でなければ空 dict を返し、以降の ``.get(...)`` を型安全にする。
    """
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


# ホスト設定のキャッシュ（モジュールレベル）
_hosts_config: dict[str, Any] | None = None


def load_hosts_config() -> dict[str, Any]:
    """ホスト設定をロード（キャッシュ付き）

    config/hosts.json からホスト設定を読み込む。
    ファイルが存在しない場合は空の設定を返す。

    Returns:
        ホスト設定の辞書
    """
    global _hosts_config
    if _hosts_config is not None:
        return _hosts_config

    hosts_file = get_config_dir() / "hosts.json"
    loaded: dict[str, Any]
    if hosts_file.exists():
        with hosts_file.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
    else:
        loaded = {"hosts": {}}
    _hosts_config = loaded
    return loaded


def get_host_config(host: str) -> dict[str, Any] | None:
    """ホストの設定を取得

    Args:
        host: GitHubホスト（例: "github.com", "ghes.example.com"）

    Returns:
        ホスト設定の辞書（env_var, token_url, description）、見つからない場合はNone
    """
    config = load_hosts_config()
    return config.get("hosts", {}).get(host)


# hosts.json に定義が無いときの既定の環境変数名。hosts.json.sample・.env.sample と同じ名前
DEFAULT_ENV_VAR_MAP: dict[str, str] = {"github.com": "PECOT_GITHUB_COM_TOKEN"}


def get_env_var_name(host: str) -> str:
    """ホストに対応する環境変数名を取得

    1. hosts.jsonに定義があればそれを使用
    2. なければ既定の対応（DEFAULT_ENV_VAR_MAP）を使用
    3. どちらにも無ければフォールバック命名規則を適用

    hosts.json はリポに含まれないため、Actions などの新しい checkout では 2 が使われる

    Args:
        host: GitHubホスト

    Returns:
        環境変数名

    Examples:
        >>> get_env_var_name("github.com")
        'PECOT_GITHUB_COM_TOKEN'

        >>> get_env_var_name("gitlab.example.com")
        'PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN'
    """
    host_config = get_host_config(host)
    if host_config:
        return host_config["env_var"]

    default = DEFAULT_ENV_VAR_MAP.get(host)
    if default:
        return default

    # フォールバック: ドットをアンダースコアに変換
    host_part = host.upper().replace(".", "_")
    return f"PECOT_GITHUB_{host_part}_TOKEN"


# ルート .env の変数名マッピング（ホスト → ルート .env の変数名）
# MCP ラッパーと同じトークンソースを参照するための定義
ROOT_ENV_VAR_MAP: dict[str, str] = {
    "github.com": "GITHUB_COM_TOKEN",
}


def load_env_file(env_file: Path) -> None:
    """環境変数ファイルをロードして環境変数に設定

    シンプルな KEY=VALUE 形式をパースする。
    コメント行（#で始まる）と空行はスキップ。

    Args:
        env_file: .envファイルのパス
    """
    if not env_file.exists():
        return

    with env_file.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # 空行とコメント行をスキップ
            if not line or line.startswith("#"):
                continue
            # KEY=VALUE形式をパース
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                # 既存の環境変数を上書きしない
                # interface-env: none
                if key and key not in os.environ:
                    os.environ[key] = value


def clear_hosts_config_cache() -> None:
    """ホスト設定キャッシュをクリア（テスト用）"""
    global _hosts_config
    _hosts_config = None


def ensure_env_file(host: str) -> Path:
    """認証用の.envファイルを生成/更新

    .envファイルが存在しない場合は新規作成。
    存在する場合は、指定ホストの環境変数が未設定なら追記。

    Args:
        host: GitHubホスト

    Returns:
        .envファイルのパス
    """
    env_file = get_config_dir() / ".env"
    env_var_name = get_env_var_name(host)
    host_config = get_host_config(host)
    token_url = host_config["token_url"] if host_config else f"https://{host}/settings/tokens"
    scopes: list[str] = host_config.get("scopes", []) if host_config else []
    description = host_config["description"] if host_config else host

    # スコープ情報のコメント
    scopes_comment = f"# 必要なスコープ: {', '.join(scopes)}" if scopes else ""

    if not env_file.exists():
        # 新規作成
        header = """# pecot-cli 認証設定
# 各トークンの値を設定してください
#
# トークン作成時は必要なスコープを付与してください
"""
        entry = f"""
# {description}
# 取得先: {token_url}
{scopes_comment}
{env_var_name}=
"""
        env_file.write_text(header + entry, encoding="utf-8")
    else:
        # 既存ファイルに追記（環境変数が未定義の場合のみ）
        content = env_file.read_text(encoding="utf-8")
        if env_var_name not in content:
            entry = f"""
# {description}
# 取得先: {token_url}
{scopes_comment}
{env_var_name}=
"""
            with env_file.open("a", encoding="utf-8") as f:
                f.write(entry)

    return env_file
