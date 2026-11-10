"""Lambda の webhook 受け口（.github/board-sync/handler.mjs）の node:test を pytest から動かす (#175)。

ディレクトリを渡すと失敗し、引数なしでは .github を探さず 0 件で通る。そのためファイル名を明示する。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BOARD_SYNC = _REPO_ROOT / ".github/board-sync"


def test_handler_node_tests_pass() -> None:
    result = subprocess.run(
        ["node", "--test", "--test-reporter=tap", ".github/board-sync/handler.test.mjs"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    count = re.search(r"^# tests (\d+)$", result.stdout, flags=re.M)
    assert count, result.stdout
    assert int(count.group(1)) >= 1
    for name in ("fail", "skipped", "todo"):
        assert re.search(rf"^# {name} 0$", result.stdout, flags=re.M), result.stdout


def _template() -> dict[str, Any]:
    # 短い形の CFN タグは使わない前提で、safe_load で読む。
    return yaml.safe_load((_BOARD_SYNC / "template.yaml").read_text(encoding="utf-8"))


def _handler_text() -> str:
    return (_BOARD_SYNC / "handler.mjs").read_text(encoding="utf-8")


def _permissions() -> list[dict[str, Any]]:
    resources = _template()["Resources"]
    return [r["Properties"] for r in resources.values() if r["Type"] == "AWS::Lambda::Permission"]


def test_public_invoke_function_requires_function_url() -> None:
    # 条件が無いと、誰でも Invoke API で Scheduler と同じ event を渡せる。
    props = [p for p in _permissions() if p["Action"] == "lambda:InvokeFunction"]
    assert len(props) == 1
    assert props[0]["InvokedViaFunctionUrl"] is True


def test_public_invoke_function_url_is_auth_none_only() -> None:
    props = [p for p in _permissions() if p["Action"] == "lambda:InvokeFunctionUrl"]
    assert len(props) == 1
    assert props[0]["FunctionUrlAuthType"] == "NONE"


def test_function_environment_has_every_key_handler_reads() -> None:
    handler = _handler_text()
    prefixes = re.findall(r'prefix: "([A-Z_]+_)"', handler)
    assert prefixes == ["SECURITY_", "DEPENDABOT_PRS_"]
    suffixes = re.findall(r"\$\{prefix\}([A-Z_]+)`", handler)
    assert sorted(set(suffixes)) == [
        "APP_CLIENT_ID",
        "APP_INSTALLATION_ID",
        "SSM_PRIVATE_KEY_NAME",
        "SSM_WEBHOOK_SECRET_NAME",
        "WORKFLOW_FILE",
    ]
    expected = {f"{p}{s}" for p in prefixes for s in suffixes} | {
        "GITHUB_REPOSITORY_ID",
        "GITHUB_REPOSITORY",
        "DISPATCH_REF",
        "CONFIG_VERSION",
    }
    variables = _template()["Resources"]["Function"]["Properties"]["Environment"]["Variables"]
    assert set(variables) == expected


def test_schedule_input_source_matches_handler() -> None:
    source = re.search(r'const SCHEDULER_SOURCE = "([^"]+)"', _handler_text())
    assert source
    target = _template()["Resources"]["Schedule"]["Properties"]["Target"]
    assert yaml.safe_load(target["Input"]) == {"source": source.group(1)}


def test_deploy_ssm_paths_match_template_defaults() -> None:
    deploy = (_BOARD_SYNC / "deploy.sh").read_text(encoding="utf-8")
    prefix = re.search(r'^SSM_PREFIX="([^"]+)"$', deploy, flags=re.M)
    assert prefix
    leaves = re.findall(r'_PARAM="\$SSM_PREFIX/\$PUT_APP/([a-z-]+)"', deploy)
    assert leaves == ["app-private-key", "webhook-secret"]
    parameters = _template()["Parameters"]
    defaults = {
        parameters[f"{app}Ssm{kind}Name"]["Default"]
        for app in ("Security", "DependabotPrs")
        for kind in ("PrivateKey", "WebhookSecret")
    }
    expected = {
        f"{prefix.group(1)}/{app}/{leaf}"
        for app in ("security", "dependabot-prs")
        for leaf in leaves
    }
    assert defaults == expected


def test_both_roles_carry_the_permissions_boundary() -> None:
    resources = _template()["Resources"]
    for name in ("Role", "SchedulerRole"):
        boundary = resources[name]["Properties"]["PermissionsBoundary"]
        assert boundary["Fn::Sub"].endswith(":policy/pecot-board-sync-boundary"), name


def test_scheduler_trust_source_arn_is_the_schedule_group() -> None:
    # Scheduler は aws:SourceArn に schedule ではなく schedule group の ARN を渡す
    resources = _template()["Resources"]
    group = resources["Schedule"]["Properties"].get("GroupName", "default")
    statement = resources["SchedulerRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]
    source_arn = statement["Condition"]["ArnEquals"]["aws:SourceArn"]["Fn::Sub"]
    assert source_arn.endswith(f":schedule-group/{group}")
