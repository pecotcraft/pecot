"""Lambda の webhook 受け口（.github/board-sync/handler.mjs）の node:test を pytest から動かす (#175)。

ディレクトリを渡すと失敗し、引数なしでは .github を探さず 0 件で通る。そのためファイル名を明示する。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BOARD_SYNC = _REPO_ROOT / ".github/board-sync"


@allure.title(
    "handler.test.mjs の node:test を pytest から実行すると、失敗・skip・todo が 0 件で終わる"
)
def test_handler_node_tests_pass() -> None:
    """Lambda の webhook 受け口（`.github/board-sync/handler.mjs`）の `node:test` を、pytest から実行するテストです。終了コードが 0 で、実行したテストが 1 件以上あり、失敗・skip・todo が 0 件であることを確認します。"""
    with allure.step("handler.test.mjs を node --test で動かす"):
        result = run_attached(
            ["node", "--test", "--test-reporter=tap", ".github/board-sync/handler.test.mjs"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    with allure.step("終了コード 0 と、テスト数・失敗 0 を確かめる"):
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


@allure.title("公開した lambda:InvokeFunction の許可は、関数 URL 経由の呼び出しだけに限る")
def test_public_invoke_function_requires_function_url() -> None:
    # 条件が無いと、誰でも Invoke API で Scheduler と同じ event を渡せる。
    """Lambda の公開された呼び出しの許可（`lambda:InvokeFunction`）の、条件のテストです。許可が 1 件だけで、`InvokedViaFunctionUrl` が `true` であることを確認します。"""
    with allure.step("lambda:InvokeFunction の Permission を template から集める"):
        props = [p for p in _permissions() if p["Action"] == "lambda:InvokeFunction"]

    with allure.step("InvokedViaFunctionUrl が True の 1 件だけであることを確かめる"):
        assert len(props) == 1
        assert props[0]["InvokedViaFunctionUrl"] is True


@allure.title("公開した lambda:InvokeFunctionUrl の許可は、認証なし（NONE）の 1 件だけにする")
def test_public_invoke_function_url_is_auth_none_only() -> None:
    """Lambda の関数 URL の呼び出しの許可（`lambda:InvokeFunctionUrl`）のテストです。許可が 1 件だけで、`FunctionUrlAuthType` が `NONE` であることを確認します。"""
    with allure.step("lambda:InvokeFunctionUrl の Permission を template から集める"):
        props = [p for p in _permissions() if p["Action"] == "lambda:InvokeFunctionUrl"]

    with allure.step("認証が NONE の 1 件だけであることを確かめる"):
        assert len(props) == 1
        assert props[0]["FunctionUrlAuthType"] == "NONE"


@allure.title("ハンドラが読む環境変数のキーは、すべて関数の環境変数として定義する")
def test_function_environment_has_every_key_handler_reads() -> None:
    """`handler.mjs` が読み込む環境変数と、`template.yaml` の関数の環境変数のテストです。アプリごとの接頭辞を付けたキーなどが、関数の `Environment` に過不足なく定義されていることを確認します。"""
    with allure.step("handler.mjs から prefix を取り出す"):
        handler = _handler_text()
        prefixes = re.findall(r'prefix: "([A-Z_]+_)"', handler)

    with allure.step("prefix が 2 つであることを確かめる"):
        assert prefixes == ["SECURITY_", "DEPENDABOT_PRS_"]

    with allure.step("handler.mjs から環境変数の接尾辞を取り出す"):
        suffixes = re.findall(r"\$\{prefix\}([A-Z_]+)`", handler)

    with allure.step("接尾辞の一覧を確かめる"):
        assert sorted(set(suffixes)) == [
            "APP_CLIENT_ID",
            "APP_INSTALLATION_ID",
            "SSM_PRIVATE_KEY_NAME",
            "SSM_WEBHOOK_SECRET_NAME",
            "WORKFLOW_FILE",
        ]

    with allure.step("定期実行の環境変数を取り出す"):
        scheduled = re.findall(r'workflowEnv: "([A-Z_]+)"', handler)

    with allure.step("定期実行の環境変数が 4 つであることを確かめる"):
        assert len(scheduled) == 4

    with allure.step("期待する環境変数の集合を組み、template の Variables と比べて確かめる"):
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


@allure.title("WorkflowFile のパラメータの既定値は、存在するワークフローのファイル名にする")
def test_workflow_file_defaults_name_existing_workflows() -> None:
    """`template.yaml` の `WorkflowFile` で終わるパラメータ 4 件のテストです。既定値のファイルが、すべて `.github/workflows` に存在することを確認します。"""
    with allure.step("template の WorkflowFile のパラメータを集める"):
        parameters = _template()["Parameters"]
        names = [name for name in parameters if name.endswith("WorkflowFile")]

    with allure.step("4 つあり、既定のワークフローが実在することを確かめる"):
        assert len(names) == 4
        for name in names:
            workflow = _REPO_ROOT / ".github/workflows" / parameters[name]["Default"]
            assert workflow.is_file(), name


@allure.title("スケジュールの入力の source は、ハンドラの SCHEDULER_SOURCE と一致する")
def test_schedule_input_source_matches_handler() -> None:
    """`template.yaml` のスケジュールの入力と、`handler.mjs` の定数のテストです。入力の JSON の `source` が、`SCHEDULER_SOURCE` の値と一致することを確認します。"""
    with allure.step("handler.mjs の SCHEDULER_SOURCE を読む"):
        source = re.search(r'const SCHEDULER_SOURCE = "([^"]+)"', _handler_text())

    with allure.step("Schedule の Input が handler の source と一致することを確かめる"):
        assert source
        target = _template()["Resources"]["Schedule"]["Properties"]["Target"]
        assert yaml.safe_load(target["Input"]) == {"source": source.group(1)}


@allure.title("deploy.sh が書き込む SSM パラメータのパスは、template の既定値と一致する")
def test_deploy_ssm_paths_match_template_defaults() -> None:
    """`deploy.sh` が書き込む SSM パラメータのパスのテストです。アプリごとの秘密鍵と webhook の secret のパスが、`template.yaml` のパラメータの既定値と一致することを確認します。"""
    with allure.step("deploy.sh から SSM の prefix とパスを読む"):
        deploy = (_BOARD_SYNC / "deploy.sh").read_text(encoding="utf-8")
        prefix = re.search(r'^SSM_PREFIX="([^"]+)"$', deploy, flags=re.M)

    with allure.step("SSM のパスが template の既定値と一致することを確かめる"):
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


@allure.title("kms:Decrypt の拒否は、Lambda 経由の復号だけを例外にする")
def test_agent_decrypt_deny_exempts_only_lambda() -> None:
    """エージェントのロールのポリシー（`NoDecryptOutsideLambda`）のテストです。`kms:Decrypt` の拒否が、`kms:ViaService` が Lambda の場合だけを除外する条件であることを確認します。"""
    with allure.step("agent の policy から NoDecryptOutsideLambda の Deny を読む"):
        deny = _agent_denies()["NoDecryptOutsideLambda"]

    with allure.step("Lambda 経由以外の復号だけを拒むことを確かめる"):
        assert deny["Action"] == "kms:Decrypt"
        assert deny["Resource"] == "*"
        assert deny["Condition"] == {
            "StringNotEquals": {"kms:ViaService": "lambda.<REGION>.amazonaws.com"}
        }


@allure.title("secret の読み出しの拒否は、条件を付けず、常に有効にする")
def test_agent_secret_reads_stay_denied_unconditionally() -> None:
    """エージェントのロールのポリシー（`NoSecretReads`）のテストです。`ssm:GetParameter` などの拒否が、`Condition` を持たず、すべてのリソースに適用されることを確認します。"""
    with allure.step("agent の policy から NoSecretReads の Deny を読む"):
        deny = _agent_denies()["NoSecretReads"]

    with allure.step("条件なしで secret の読み出しを拒むことを確かめる"):
        assert "Condition" not in deny
        assert deny["Resource"] == "*"
        assert {"ssm:GetParameter", "ssm:GetParameters", "secretsmanager:GetSecretValue"} <= set(
            deny["Action"]
        )


@allure.title("deploy.sh が使う環境変数名の抽出は、template の環境変数と一致する")
def test_deploy_env_keys_parse_from_template() -> None:
    """`deploy.sh` が環境変数の反映を確認するために使う、変数名の抽出のテストです。`sed` で `template.yaml` から取り出した名前が、関数の環境変数のキーと順序も含めて一致することを確認します。"""
    with allure.step("環境変数名を取り出すコマンドと deploy.sh を用意する"):
        script = (
            "sed -n '/^        Variables:$/,/^      [^ ]/p' \"$1\" | "
            "sed -n 's/^          \\([A-Z_][A-Z0-9_]*\\):$/\\1/p'"
        )
        deploy = (_BOARD_SYNC / "deploy.sh").read_text(encoding="utf-8")

    with allure.step("deploy.sh に同じ取り出しのコマンドがあることを確かめる"):
        assert "sed -n '/^        Variables:$/,/^      [^ ]/p'" in deploy

    with allure.step("取り出しのコマンドを template に当てて、環境変数名を得る"):
        out = run_attached(
            ["bash", "-c", script, "_", str(_BOARD_SYNC / "template.yaml")],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
        variables = _template()["Resources"]["Function"]["Properties"]["Environment"]["Variables"]

    with allure.step("取り出した名前が template の Variables と一致することを確かめる"):
        assert out == list(variables)


@allure.title("2 つのロールには、どちらも権限境界を設定する")
def test_both_roles_carry_the_permissions_boundary() -> None:
    """`template.yaml` の `Role` と `SchedulerRole` のテストです。どちらの `PermissionsBoundary` も、`pecot-board-sync-boundary` のポリシーを指していることを確認します。"""
    with allure.step("template の Resources を読む"):
        resources = _template()["Resources"]

    with allure.step("2 つの role に permissions boundary が付くことを確かめる"):
        for name in ("Role", "SchedulerRole"):
            boundary = resources[name]["Properties"]["PermissionsBoundary"]
            assert boundary["Fn::Sub"].endswith(":policy/pecot-board-sync-boundary"), name


@allure.title(
    "Scheduler ロールの信頼ポリシーは、aws:SourceArn にスケジュールグループの ARN を指定する"
)
def test_scheduler_trust_source_arn_is_the_schedule_group() -> None:
    # Scheduler は aws:SourceArn に schedule ではなく schedule group の ARN を渡す
    """`SchedulerRole` の信頼ポリシーのテストです。条件の `aws:SourceArn` が、スケジュールではなくスケジュールグループの ARN で終わることを確認します。"""
    with allure.step("Scheduler の trust policy から SourceArn を読む"):
        resources = _template()["Resources"]
        group = resources["Schedule"]["Properties"].get("GroupName", "default")
        statement = resources["SchedulerRole"]["Properties"]["AssumeRolePolicyDocument"][
            "Statement"
        ][0]
        source_arn = statement["Condition"]["ArnEquals"]["aws:SourceArn"]["Fn::Sub"]

    with allure.step("SourceArn が schedule group の ARN で終わることを確かめる"):
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
    return run_attached(
        ["bash", str(_BOARD_SYNC / "deploy.sh"), *args],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )


def _last_line(result: subprocess.CompletedProcess[str]) -> str:
    return result.stderr.rstrip("\n").splitlines()[-1].strip()


@allure.title(
    "{args} を指定して認証情報の確認に失敗すると、{expected} を付けた aws login のコマンドを表示して終了する"
)
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
    """認証情報の期限が切れた状態で `deploy.sh` を実行したときの、案内のテストです。終了コード 1 で終わり、期限切れのメッセージと、`aws login --remote` に正しいプロファイルとリージョンを付けたコマンドを表示し、`gh` を呼び出さないことを確認します。"""
    with allure.step("認証情報が失敗する状態で deploy.sh を動かす"):
        result = _run_deploy(tmp_path, args, config)

    with allure.step("終了コード 1 と、実行できる aws login の案内を確かめる"):
        assert result.returncode == 1, result.stderr
        assert _EXPIRED in result.stderr
        assert _last_line(result) == f"aws login --remote {expected}"
        assert not (tmp_path / "gh-called").exists()


@allure.title("SSO など aws login ではない認証情報の期限が切れても、aws login を案内しない")
def test_deploy_does_not_suggest_aws_login_for_other_credentials(tmp_path: Path) -> None:
    """SSO の認証情報の期限が切れた状態で `deploy.sh` を実行したときのテストです。終了コード 1 で終わり、`aws login` を案内せずに、認証情報を取得できないエラーを表示することを確認します。"""
    with allure.step("SSO の設定で認証が失敗する状態で deploy.sh を動かす"):
        config = {"sso": {"sso_session": "corp", "sso_account_id": "111111111111"}}
        result = _run_deploy(
            tmp_path, ["--profile", "sso"], config, sts_error="aws: [ERROR]: Token has expired"
        )

    with allure.step("aws login を案内せず、エラーで止まることを確かめる"):
        assert result.returncode == 1, result.stderr
        assert "aws login" not in result.stderr
        assert _last_line(result) == "ERROR: AWS の認証情報を得られません"
        assert not (tmp_path / "gh-called").exists()


@allure.title("認証情報の確認に失敗すると、secret の入力を求める前に終了する")
def test_deploy_stops_before_secret_prompt(tmp_path: Path) -> None:
    """`--put-secrets` を指定して `deploy.sh` を実行したときのテストです。認証情報が使えない場合に、webhook の secret の入力を求める前に、終了コード 1 で終わることを確認します。"""
    with allure.step("鍵ファイルを用意し、認証が失敗する状態で deploy.sh を動かす"):
        key = tmp_path / "key.pem"
        key.write_text("dummy\n", encoding="utf-8")
        result = _run_deploy(
            tmp_path, ["--profile", "pecot", "--put-secrets", "security", str(key)], _PECOT_CONFIG
        )

    with allure.step("secret の入力を求める前に止まることを確かめる"):
        assert result.returncode == 1, result.stderr
        assert "webhook の secret" not in result.stderr
        assert "初回は" not in result.stderr
        assert _last_line(result) == "aws login --remote --profile pecot --region ap-southeast-2"


@allure.title("認証情報が使えると、確認を通過して gh を呼び出す")
def test_deploy_passes_the_check_when_credentials_work(tmp_path: Path) -> None:
    """認証情報の確認が成功する場合の、`deploy.sh` のテストです。確認を通過して `gh` を呼び出し、`aws login` を案内しないことを確認します。"""
    with allure.step("認証が通る状態で deploy.sh を動かす"):
        result = _run_deploy(tmp_path, ["--profile", "pecot"], _PECOT_CONFIG, sts_error=None)

    with allure.step("gh が呼ばれ、aws login を案内しないことを確かめる"):
        assert (tmp_path / "gh-called").exists(), result.stderr
        assert "aws login" not in result.stderr


@allure.title("環境変数が {extra_env} の場合に、aws login の案内に {expected} を使う")
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
    """`AWS_PROFILE` と `AWS_DEFAULT_PROFILE` を指定して `deploy.sh` を実行したときのテストです。aws-cli と同じく `AWS_PROFILE` を優先してプロファイルを選び、`aws login` のコマンドに表示することを確認します。"""
    with allure.step("環境変数でプロファイルを指して deploy.sh を動かす"):
        config = {
            "a": {"source_profile": "pecot"},
            "other": {"login_session": _LOGIN_SESSION},
            **_PECOT_CONFIG,
        }
        result = _run_deploy(tmp_path, [], config, extra_env=extra_env)

    with allure.step("案内の aws login が、期待するプロファイルを使うことを確かめる"):
        assert result.returncode == 1, result.stderr
        assert _last_line(result) == f"aws login --remote {expected} --region ap-southeast-2"


@allure.title("アクセスキーの環境変数で認証している場合は、aws login を案内しない")
def test_deploy_does_not_suggest_aws_login_for_env_keys(tmp_path: Path) -> None:
    """`AWS_ACCESS_KEY_ID` を指定して `deploy.sh` を実行したときのテストです。終了コード 1 で終わり、`aws login --remote` を案内せずに、認証情報を取得できないエラーを表示することを確認します。"""
    with allure.step("環境変数のアクセスキーで認証が失敗する状態で deploy.sh を動かす"):
        result = _run_deploy(
            tmp_path, [], _PECOT_CONFIG, extra_env={"AWS_ACCESS_KEY_ID": "AKIAFAKE"}
        )

    with allure.step("aws login を案内せず、エラーで止まることを確かめる"):
        assert result.returncode == 1, result.stderr
        assert "aws login --remote" not in result.stderr
        assert _last_line(result) == "ERROR: AWS の認証情報を得られません"
