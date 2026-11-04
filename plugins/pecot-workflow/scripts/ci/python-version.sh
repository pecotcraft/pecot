# run-tests.sh / run-lint.sh が source する、cli/.venv の interpreter 版（PY）の定義。
# 両スクリプトは同じ venv を共有するため、異なる版を指定すると片方が venv を作り直す間に
# 他方が実行中の venv を壊す。1 か所で定義して食い違いを構造的に排除する。
# 3.14 は pyproject の requires-python (>=3.10,<3.15) を満たす。
# devcontainer の system python（/usr/bin/python3.14）に解決される。
# requires-python との一致は .githooks/pre-commit/tests/test_python_range_parity.py が確かめる。
PY=3.14
