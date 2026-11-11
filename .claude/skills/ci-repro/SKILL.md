---
name: ci-repro
description: PR の CI（checks (lint) や tests (<project>:<target>)）が落ちたとき、手元で同じ失敗を再現して落ちたテストを特定する手順。CI の失敗の調査・再現・再実行のときに使う。
---

# CI の失敗を手元で再現する

1. 落ちた job の Summary と artifact（`ci-logs-<part>`・`ci-logs-tests-<slug>`）で、落ちたレーンとテストを特定する
2. `git fetch origin main` を打つ。CI は PR の merge commit で動き、範囲の base は origin/HEAD との merge-base で決まる
3. 再現する。`NX_SKIP_NX_CACHE=true` を付けないと、前に通ったレーンが local-cache で成功に見える
   - 1 レーン（job 名の `<project>:<target>` をそのまま使う。dependsOn と環境変数が CI と同じに付く）

     ```
     NX_SKIP_NX_CACHE=true PECOTV_E2E_CEILING_SCALE=3 pnpm exec nx run <project>:<target>
     ```

   - 変更が届いたレーンすべて

     ```
     NX_SKIP_NX_CACHE=true pre-commit run --hook-stage manual nx-affected-tests --from-ref origin/main --to-ref HEAD
     ```

   - `checks (lint)`（CI は version plan の確認を動かさないので `SKIP` でそろえる）

     ```
     pre-commit run --from-ref origin/main --to-ref HEAD
     SKIP=check-version-plan-required pre-commit run --hook-stage pre-push --from-ref origin/main --to-ref HEAD
     ```

4. 特定できたら、そのテストだけを再実行する。`<scope>` はレーン名 `test-<scope>` に当たる

   ```
   plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=<py|cli|hooks|skills>
   plugins/pecot-visual/scripts/ci/run-tests.sh --scope=<cli|bootstrap|slidev|hooks|release|compare|skills>
   plugins/pecot-tools/scripts/ci/run-tests.sh --scope=<cli|bootstrap|release>
   ```

   - githooks は `.githooks/tests/run.sh <file>`。text-rules・interface-spec・nx-release には `run-tests.sh` が無いので、手順 3 の `nx run` を使う

`pre-commit run` は staged でない変更を退避して index の内容で動くので、直しは `git add` してから打ち直します。
