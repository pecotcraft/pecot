"""core/errors.py - pecot CLI の例外基底

CLI 内の独自例外はすべて ``PecotError`` を最上位の基底にする。
"""

from __future__ import annotations


class PecotError(Exception):
    """pecot CLI の独自例外の基底クラス"""
