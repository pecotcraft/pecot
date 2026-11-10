"""Fixture source read by the environment check."""

import os


def api_url() -> str:
    return os.environ.get("PECOT_GITHUB_API_URL", "https://api.github.com")


def token(host: str) -> str | None:
    env_name = f"PECOT_GITHUB_{host.upper()}_TOKEN"
    # interface-env: PECOT_GITHUB_*_TOKEN
    return os.environ.get(env_name)


def child_environment() -> dict[str, str]:
    # interface-env: none
    return dict(os.environ)


def project_dir() -> str:
    return os.environ["PECOT_SESSION_PROJECT_DIR"]
