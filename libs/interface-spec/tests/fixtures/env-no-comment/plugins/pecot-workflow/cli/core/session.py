"""Reads that hide their names."""

import os


def read(name: str) -> str | None:
    return os.environ.get(name)


def everything() -> dict[str, str]:
    return {**os.environ}
