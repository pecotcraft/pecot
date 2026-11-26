"""Lambda の webhook 受け口（.github/board-sync/handler.mjs）の node:test を pytest から動かす (#175)。

ディレクトリを渡すと失敗し、引数なしでは .github を探さず 0 件で通る。そのためファイル名を明示する。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest
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
    scheduled = re.findall(r'workflowEnv: "([A-Z_]+)"', handler)
    assert len(scheduled) == 4
    expected = (
        {f"{p}{s}" for p in prefixes for s in suffixes}
        | set(scheduled)
        | {
            "GITHUB_REPOSITORY_ID",
            "GITHUB_REPOSITORY",
            "DISPATCH_REF",
            "CONFIG_VERSION",
        }
    )
    variables = _template()["Resources"]["Function"]["Properties"]["Environment"]["Variables"]
    assert set(variables) == expected


def test_workflow_file_defaults_name_existing_workflows() -> None:
    parameters = _template()["Parameters"]
    names = [name for name in parameters if name.endswith("WorkflowFile")]
    assert len(names) == 4
    for name in names:
        workflow = _REPO_ROOT / ".github/workflows" / parameters[name]["Default"]
        assert workflow.is_file(), name


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


def _agent_denies() -> dict[str, dict[str, Any]]:
    policy = json.loads((_BOARD_SYNC / "agent-role-policy.json").read_text(encoding="utf-8"))
    return {s["Sid"]: s for s in policy["Statement"] if s["Effect"] == "Deny"}


def test_agent_decrypt_deny_exempts_only_lambda() -> None:
    """Deny が Lambda 経由の復号まで拒むと、デプロイが環境変数を書き換えない (#487)。"""
    deny = _agent_denies()["NoDecryptOutsideLambda"]
    assert deny["Action"] == "kms:Decrypt"
    assert deny["Resource"] == "*"
    assert deny["Condition"] == {
        "StringNotEquals": {"kms:ViaService": "lambda.<REGION>.amazonaws.com"}
    }


def test_agent_secret_reads_stay_denied_unconditionally() -> None:
    deny = _agent_denies()["NoSecretReads"]
    assert "Condition" not in deny
    assert deny["Resource"] == "*"
    assert {"ssm:GetParameter", "ssm:GetParameters", "secretsmanager:GetSecretValue"} <= set(
        deny["Action"]
    )


def test_deploy_env_keys_parse_from_template() -> None:
    """deploy.sh が反映を確かめる名前の取り出しが、template の環境変数と一致する (#487)。"""
    script = (
        "sed -n '/^        Variables:$/,/^      [^ ]/p' \"$1\" | "
        "sed -n 's/^          \\([A-Z_][A-Z0-9_]*\\):$/\\1/p'"
    )
    deploy = (_BOARD_SYNC / "deploy.sh").read_text(encoding="utf-8")
    assert "sed -n '/^        Variables:$/,/^      [^ ]/p'" in deploy
    out = subprocess.run(
        ["bash", "-c", script, "_", str(_BOARD_SYNC / "template.yaml")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    variables = _template()["Resources"]["Function"]["Properties"]["Environment"]["Variables"]
    assert out == list(variables)


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


_FAKE_AWS = """#!/usr/bin/env python3
import json, os, sys
cfg = json.loads(os.environ["FAKE_AWS_CONFIG"])
args, rest = sys.argv[1:], []
profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
i = 0
while i < len(args):
    if args[i] in ("--region", "--profile"):
        profile = args[i + 1] if args[i] == "--profile" else profile
        i += 2
        continue
    rest.append(args[i])
    i += 1
if rest[:2] == ["configure", "list-profiles"]:
    print("\\n".join(cfg))
    sys.exit(0)
if rest[:2] == ["configure", "get"]:
    name = profile or "default"
    if name not in cfg:
        print(f"aws: [ERROR]: The config profile ({name}) could not be found", file=sys.stderr)
        sys.exit(255)
    value = cfg[name].get(rest[2])
    if value is None:
        sys.exit(1)
    print(value)
    sys.exit(0)
if rest[:2] == ["sts", "get-caller-identity"]:
    error = os.environ.get("FAKE_STS_ERROR")
    if error:
        print(error, file=sys.stderr)
        sys.exit(254)
    print("{}")
    sys.exit(0)
print("unexpected aws call: " + " ".join(sys.argv[1:]), file=sys.stderr)
sys.exit(99)
"""

_EXPIRED = "aws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'."
_LOGIN_SESSION = "arn:aws:sts::111111111111:assumed-role/AccountFullAccessRole/x"
_PECOT_CONFIG: dict[str, dict[str, str]] = {
    "pecot": {"login_session": _LOGIN_SESSION},
    "default": {
        "role_arn": "arn:aws:iam::111111111111:role/claude-agent",
        "source_profile": "pecot",
    },
}


def _run_deploy(
    tmp_path: Path,
    args: list[str],
    config: dict[str, dict[str, str]],
    sts_error: str | None = _EXPIRED,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """偽の aws・gh を PATH の先頭に置いて deploy.sh を動かす (#776)。gh は呼ばれた印を残して止まる。"""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "aws").write_text(_FAKE_AWS, encoding="utf-8")
    (bin_dir / "gh").write_text(
        f'#!/usr/bin/env bash\ntouch "{tmp_path}/gh-called"\nexit 1\n', encoding="utf-8"
    )
    for tool in ("aws", "gh"):
        (bin_dir / tool).chmod(0o755)
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in (
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_CONFIG_FILE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
        )
    }
    env.update(extra_env or {})
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["FAKE_AWS_CONFIG"] = json.dumps(config)
    env.pop("FAKE_STS_ERROR", None)
    if sts_error:
        env["FAKE_STS_ERROR"] = sts_error
    return subprocess.run(
        ["bash", str(_BOARD_SYNC / "deploy.sh"), *args],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )


def _last_line(result: subprocess.CompletedProcess[str]) -> str:
    return result.stderr.rstrip("\n").splitlines()[-1].strip()


@pytest.mark.parametrize(
    ("args", "config", "expected"),
    [
        (["--profile", "pecot"], _PECOT_CONFIG, "--profile pecot --region ap-southeast-2"),
        ([], _PECOT_CONFIG, "--profile pecot --region ap-southeast-2"),
        (
            ["--profile", "a"],
            {"a": {"source_profile": "b"}, "b": {"source_profile": "pecot"}, **_PECOT_CONFIG},
            "--profile pecot --region ap-southeast-2",
        ),
        (
            ["--profile", "foo", "--region", "us-west-2"],
            {"foo": {"login_session": _LOGIN_SESSION}},
            "--profile foo --region us-west-2",
        ),
        (["--profile", "missing"], _PECOT_CONFIG, "--profile missing --region ap-southeast-2"),
    ],
    ids=["pecot", "default-role", "two-hops", "other-region", "missing-profile"],
)
def test_deploy_shows_runnable_login_command_when_credentials_fail(
    tmp_path: Path, args: list[str], config: dict[str, dict[str, str]], expected: str
) -> None:
    result = _run_deploy(tmp_path, args, config)
    assert result.returncode == 1, result.stderr
    assert _EXPIRED in result.stderr
    assert _last_line(result) == f"aws login --remote {expected}"
    assert not (tmp_path / "gh-called").exists()


def test_deploy_does_not_suggest_aws_login_for_other_credentials(tmp_path: Path) -> None:
    config = {"sso": {"sso_session": "corp", "sso_account_id": "111111111111"}}
    result = _run_deploy(
        tmp_path, ["--profile", "sso"], config, sts_error="aws: [ERROR]: Token has expired"
    )
    assert result.returncode == 1, result.stderr
    assert "aws login" not in result.stderr
    assert _last_line(result) == "ERROR: AWS の認証情報を得られません"
    assert not (tmp_path / "gh-called").exists()


def test_deploy_stops_before_secret_prompt(tmp_path: Path) -> None:
    key = tmp_path / "key.pem"
    key.write_text("dummy\n", encoding="utf-8")
    result = _run_deploy(
        tmp_path, ["--profile", "pecot", "--put-secrets", "security", str(key)], _PECOT_CONFIG
    )
    assert result.returncode == 1, result.stderr
    assert "webhook の secret" not in result.stderr
    assert "初回は" not in result.stderr
    assert _last_line(result) == "aws login --remote --profile pecot --region ap-southeast-2"


def test_deploy_passes_the_check_when_credentials_work(tmp_path: Path) -> None:
    result = _run_deploy(tmp_path, ["--profile", "pecot"], _PECOT_CONFIG, sts_error=None)
    assert (tmp_path / "gh-called").exists(), result.stderr
    assert "aws login" not in result.stderr


@pytest.mark.parametrize(
    ("extra_env", "expected"),
    [
        ({"AWS_PROFILE": "a"}, "--profile pecot"),
        ({"AWS_DEFAULT_PROFILE": "other"}, "--profile other"),
        ({"AWS_PROFILE": "a", "AWS_DEFAULT_PROFILE": "other"}, "--profile pecot"),
    ],
    ids=["aws-profile", "aws-default-profile", "aws-profile-wins"],
)
def test_deploy_starts_from_the_profile_aws_cli_uses(
    tmp_path: Path, extra_env: dict[str, str], expected: str
) -> None:
    """aws-cli v2 は AWS_PROFILE を AWS_DEFAULT_PROFILE より先に読む（botocore の configprovider.py）。"""
    config = {
        "a": {"source_profile": "pecot"},
        "other": {"login_session": _LOGIN_SESSION},
        **_PECOT_CONFIG,
    }
    result = _run_deploy(tmp_path, [], config, extra_env=extra_env)
    assert result.returncode == 1, result.stderr
    assert _last_line(result) == f"aws login --remote {expected} --region ap-southeast-2"


def test_deploy_does_not_suggest_aws_login_for_env_keys(tmp_path: Path) -> None:
    result = _run_deploy(tmp_path, [], _PECOT_CONFIG, extra_env={"AWS_ACCESS_KEY_ID": "AKIAFAKE"})
    assert result.returncode == 1, result.stderr
    assert "aws login --remote" not in result.stderr
    assert _last_line(result) == "ERROR: AWS の認証情報を得られません"
