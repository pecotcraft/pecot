# allure-pytest は型を持たないので、docs/tests が使う分だけ型を与える（pyright の stubPath の既定）。
from collections.abc import Callable
from typing import TypeVar

_F = TypeVar("_F", bound=Callable[..., object])

def title(test_title: str) -> Callable[[_F], _F]: ...
def label(label_type: str, *labels: str) -> Callable[[_F], _F]: ...
