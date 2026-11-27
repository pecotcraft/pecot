# allure-pytest は型を持たないので、docs/tests が使う分だけ型を与える（pyright の stubPath の既定）。
from collections.abc import Callable
from contextlib import AbstractContextManager
from enum import Enum
from typing import TypeVar

_F = TypeVar("_F", bound=Callable[..., object])

class attachment_type(Enum):
    TEXT = ...
    JSON = ...

def title(test_title: str) -> Callable[[_F], _F]: ...
def label(label_type: str, *labels: str) -> Callable[[_F], _F]: ...
def step(title: str) -> AbstractContextManager[None]: ...
def attach(
    body: str | bytes,
    name: str | None = None,
    attachment_type: attachment_type | None = None,
    extension: str | None = None,
) -> None: ...
