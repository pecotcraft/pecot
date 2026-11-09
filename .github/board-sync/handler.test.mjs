import assert from "node:assert/strict";
import { createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { createAppJwt, createHandler, normalizeRequest, verifySignature } from "./handler.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SECRET = "test-webhook-secret";
const DEP_SECRET = "test-dependabot-secret";
const SECRETS = { security: SECRET, "dependabot-prs": DEP_SECRET };
const ENV = {
  GITHUB_REPOSITORY_ID: "4242",
  GITHUB_REPOSITORY: "pecotcraft/pecot",
  DISPATCH_REF: "main",
  SECURITY_APP_CLIENT_ID: "Iv1.client",
  SECURITY_APP_INSTALLATION_ID: "777",
  SECURITY_WORKFLOW_FILE: "security-alerts.yml",
  DEPENDABOT_PRS_APP_CLIENT_ID: "Iv1.depclient",
  DEPENDABOT_PRS_APP_INSTALLATION_ID: "888",
  DEPENDABOT_PRS_WORKFLOW_FILE: "dependabot-prs.yml",
};
const SECURITY_WORKFLOW_URL =
  "https://api.github.com/repos/pecotcraft/pecot/actions/workflows/security-alerts.yml/dispatches";
const DEPENDABOT_WORKFLOW_URL =
  "https://api.github.com/repos/pecotcraft/pecot/actions/workflows/dependabot-prs.yml/dispatches";
const SCHEDULER_EVENT = { source: "pecot-scheduler" };
const NOW = Date.parse("2026-11-09T00:00:00Z");

const sign = (body, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

/** fetch の呼び出しを記録し、URL に応じた応答を返す。 */
function makeDeps({
  dispatchStatus = 200,
  tokenStatus = 201,
  now = () => NOW,
  failWorkflow = null,
  failSecretsFor = null,
} = {}) {
  const calls = [];
  const logs = [];
  const secretsLoads = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/access_tokens")) {
      return jsonResponse(tokenStatus, {
        token: "ghs_secret_token",
        expires_at: new Date(now() + 3600_000).toISOString(),
      });
    }
    const status = failWorkflow && url.includes(failWorkflow) ? 500 : dispatchStatus;
    return jsonResponse(status, { workflow_run_id: url.includes("dependabot-prs") ? 9002 : 9001 });
  };
  const deps = {
    fetch: fetchFn,
    now,
    env: ENV,
    log: (entry) => logs.push(entry),
    loadSecrets: async (_env, appName) => {
      secretsLoads.push(appName);
      if (appName === failSecretsFor) throw new Error("ssm unset");
      return { privateKeyPem: privateKey, webhookSecret: SECRETS[appName] };
    },
  };
  return { deps, calls, logs, secretsLoads };
}

function makeEvent(
  eventName,
  payload,
  { signature, base64 = false, path = "/security", method = "POST", secret } = {},
) {
  const raw = JSON.stringify(payload);
  const key = secret ?? (path === "/dependabot-prs" ? DEP_SECRET : SECRET);
  const headers = { "X-GitHub-Event": eventName, "X-Hub-Signature-256": signature ?? sign(raw, key) };
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers,
    body: base64 ? Buffer.from(raw).toString("base64") : raw,
    isBase64Encoded: base64,
  };
}

const alertPayload = (extra = {}) => ({
  action: "created",
  alert: { number: 12 },
  repository: { id: 4242 },
  ...extra,
});

const dispatchCalls = (calls) => calls.filter((c) => c.url.endsWith("/dispatches"));

test("署名が一致し dependabot_alert なら dispatch して 202 を返す", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(makeEvent("dependabot_alert", alertPayload()));
  assert.equal(res.statusCode, 202);
  const [dispatch] = dispatchCalls(calls);
  assert.equal(dispatch.url, SECURITY_WORKFLOW_URL);
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: "main", return_run_details: true });
  assert.equal(dispatch.init.method, "POST");
  assert.equal(dispatch.init.headers.Authorization, "Bearer ghs_secret_token");
  assert.equal(dispatch.init.headers.Accept, "application/vnd.github+json");
  assert.equal(dispatch.init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(dispatch.init.headers["User-Agent"], "pecot-board-sync");
});

test("secret_scanning_alert も dispatch する", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(makeEvent("secret_scanning_alert", alertPayload()));
  assert.equal(res.statusCode, 202);
  assert.equal(dispatchCalls(calls).length, 1);
});

test("main の code_scanning_alert は dispatch し、main 以外の ref は何もしない", async () => {
  const main = makeDeps();
  const ok = await createHandler(main.deps)(
    makeEvent("code_scanning_alert", alertPayload({ ref: "refs/heads/main" })),
  );
  assert.equal(ok.statusCode, 202);
  assert.equal(dispatchCalls(main.calls).length, 1);

  const other = makeDeps();
  const skipped = await createHandler(other.deps)(
    makeEvent("code_scanning_alert", alertPayload({ ref: "refs/pull/5/merge" })),
  );
  assert.equal(skipped.statusCode, 202);
  assert.equal(other.calls.length, 0);
});

test("署名の不一致は 401 で、何も呼ばない", async () => {
  const { deps, calls } = makeDeps();
  const event = makeEvent("dependabot_alert", alertPayload(), { signature: sign("x", "wrong") });
  const res = await createHandler(deps)(event);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("署名ヘッダの欠落は 401", async () => {
  const { deps, calls } = makeDeps();
  const event = makeEvent("dependabot_alert", alertPayload());
  delete event.headers["X-Hub-Signature-256"];
  const res = await createHandler(deps)(event);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("署名の長さが違っても 401 で、例外にならない", async () => {
  const { deps } = makeDeps();
  const event = makeEvent("dependabot_alert", alertPayload(), { signature: "sha256=abcd" });
  const res = await createHandler(deps)(event);
  assert.equal(res.statusCode, 401);
});

test("verifySignature は一致だけを true にする", () => {
  const body = Buffer.from("hello");
  assert.equal(verifySignature(SECRET, body, sign("hello")), true);
  assert.equal(verifySignature(SECRET, body, sign("hellp")), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, ""), false);
});

test("ヘッダの名前の大文字小文字を問わない", async () => {
  const { deps, calls } = makeDeps();
  const raw = JSON.stringify(alertPayload());
  const res = await createHandler(deps)({
    rawPath: "/security",
    requestContext: { http: { method: "POST" } },
    headers: { "x-github-event": "dependabot_alert", "x-hub-signature-256": sign(raw) },
    body: raw,
  });
  assert.equal(res.statusCode, 202);
  assert.equal(dispatchCalls(calls).length, 1);
});

test("base64 で届いた body も、生の body で署名を確かめる", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(
    makeEvent("dependabot_alert", alertPayload(), { base64: true }),
  );
  assert.equal(res.statusCode, 202);
  assert.equal(dispatchCalls(calls).length, 1);
  const { body } = normalizeRequest(makeEvent("ping", { a: "あ" }, { base64: true }));
  assert.equal(body.toString("utf8"), JSON.stringify({ a: "あ" }));
});

test("ping は 200 を返し、dispatch しない", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(makeEvent("ping", { zen: "ok" }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});

test("対象外のイベントは 202 で何もしない", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(makeEvent("push", alertPayload()));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 0);
});

test("対象外のリポは 202 で何もしない", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(
    makeEvent("dependabot_alert", alertPayload({ repository: { id: 1 } })),
  );
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 0);
});

test("token の要求は repositories と permissions で絞られ、JWT は公開鍵で検証できる", async () => {
  const { deps, calls } = makeDeps();
  await createHandler(deps)(makeEvent("dependabot_alert", alertPayload()));
  const [tokenCall] = calls;
  assert.equal(tokenCall.url, "https://api.github.com/app/installations/777/access_tokens");
  assert.deepEqual(JSON.parse(tokenCall.init.body), {
    repositories: ["pecot"],
    permissions: { actions: "write" },
  });
  assert.equal(tokenCall.init.headers["User-Agent"], "pecot-board-sync");

  const jwt = tokenCall.init.headers.Authorization.replace("Bearer ", "");
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.iss, "Iv1.client");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(publicKey), Buffer.from(s, "base64url")),
    true,
  );
});

test("createAppJwt は iat を 60 秒戻し、exp を 10 分以内にする", () => {
  const jwt = createAppJwt(privateKey, "cid", NOW);
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.equal(claims.exp, NOW / 1000 + 540);
});

test("token は expires_at の 1 分前まで使い回し、その後は取り直す", async () => {
  let t = NOW;
  const { deps, calls } = makeDeps({ now: () => t });
  const handler = createHandler(deps);
  const tokenRequests = () => calls.filter((c) => c.url.endsWith("/access_tokens")).length;

  await handler(makeEvent("dependabot_alert", alertPayload()));
  t = NOW + 3000_000;
  await handler(makeEvent("dependabot_alert", alertPayload()));
  assert.equal(tokenRequests(), 1);

  t = NOW + 3600_000 - 30_000;
  await handler(makeEvent("dependabot_alert", alertPayload()));
  assert.equal(tokenRequests(), 2);
});

test("SSM の読み出しは App ごとにコールドスタートで 1 回だけ", async () => {
  const { deps, secretsLoads } = makeDeps();
  const handler = createHandler(deps);
  await handler(makeEvent("ping", {}));
  await handler(makeEvent("ping", {}));
  assert.deepEqual(secretsLoads, ["security"]);
  await handler(makeEvent("ping", {}, { path: "/dependabot-prs" }));
  await handler(makeEvent("ping", {}, { path: "/dependabot-prs" }));
  assert.deepEqual(secretsLoads, ["security", "dependabot-prs"]);
});

test("dispatch の API が失敗したら 502", async () => {
  const { deps, logs } = makeDeps({ dispatchStatus: 500 });
  const res = await createHandler(deps)(makeEvent("dependabot_alert", alertPayload()));
  assert.equal(res.statusCode, 502);
  assert.equal(logs.at(-1).result, "dispatch-error");
});

test("token の発行が失敗したら 502 で、dispatch しない", async () => {
  const { deps, calls } = makeDeps({ tokenStatus: 401 });
  const res = await createHandler(deps)(makeEvent("dependabot_alert", alertPayload()));
  assert.equal(res.statusCode, 502);
  assert.equal(dispatchCalls(calls).length, 0);
});

test("ログは 1 行の項目だけで、payload と token を含まない", async () => {
  const { deps, logs } = makeDeps();
  const payload = alertPayload({ alert: { number: 12, secret_leak: "SENSITIVE-VALUE" } });
  await createHandler(deps)(makeEvent("dependabot_alert", payload));
  assert.deepEqual(logs, [
    {
      via: "url",
      app: "security",
      event: "dependabot_alert",
      action: "created",
      alert: 12,
      run: 9001,
      result: "dispatched",
    },
  ]);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("SENSITIVE-VALUE"));
  assert.ok(!text.includes("ghs_secret_token"));
});

test("失敗時のログにも payload と token が出ない", async () => {
  const { deps, logs } = makeDeps({ dispatchStatus: 500 });
  const payload = alertPayload({ alert: { number: 3, note: "SENSITIVE-VALUE" } });
  await createHandler(deps)(makeEvent("dependabot_alert", payload));
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("SENSITIVE-VALUE"));
  assert.ok(!text.includes("ghs_secret_token"));
});

const depPr = (extra = {}, prExtra = {}) => ({
  action: "opened",
  repository: { id: 4242 },
  pull_request: {
    user: { login: "dependabot[bot]" },
    head: { repo: { full_name: "pecotcraft/pecot" } },
    ...prExtra,
  },
  ...extra,
});
const depRun = (extra = {}, runExtra = {}) => ({
  action: "completed",
  repository: { id: 4242 },
  workflow_run: { head_branch: "dependabot/npm_and_yarn/foo-1.2.3", ...runExtra },
  ...extra,
});
const depEvent = (name, payload, opts = {}) =>
  makeEvent(name, payload, { path: "/dependabot-prs", ...opts });

test("未知の path・末尾の / ・POST 以外は、署名を確かめず 404", async () => {
  for (const opts of [
    { path: "/unknown" },
    { path: "/security/" },
    { path: "/" },
    { path: "/security", method: "GET" },
    { path: "/dependabot-prs", method: "PUT" },
  ]) {
    const { deps, calls, secretsLoads } = makeDeps();
    const res = await createHandler(deps)(makeEvent("dependabot_alert", alertPayload(), opts));
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0);
    assert.equal(secretsLoads.length, 0);
  }
});

test("security の secret で署名した body を /dependabot-prs に送ると 401", async () => {
  const { deps, calls } = makeDeps();
  const event = depEvent("pull_request", depPr(), { secret: SECRET });
  const res = await createHandler(deps)(event);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("dependabot の PR は dependabot-prs.yml を dependabot-prs の App で起こす", async () => {
  const { deps, calls, logs } = makeDeps();
  const res = await createHandler(deps)(depEvent("pull_request", depPr()));
  assert.equal(res.statusCode, 202);
  const [tokenCall] = calls;
  assert.equal(tokenCall.url, "https://api.github.com/app/installations/888/access_tokens");
  const claims = JSON.parse(
    Buffer.from(tokenCall.init.headers.Authorization.split(".")[1], "base64url"),
  );
  assert.equal(claims.iss, "Iv1.depclient");
  const [dispatch] = dispatchCalls(calls);
  assert.equal(dispatch.url, DEPENDABOT_WORKFLOW_URL);
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: "main", return_run_details: true });
  assert.equal(logs.at(-1).app, "dependabot-prs");
  assert.equal(logs.at(-1).via, "url");
  assert.equal(logs.at(-1).run, 9002);
});

test("対象の action はすべて dispatch する", async () => {
  for (const action of [
    "opened",
    "reopened",
    "closed",
    "synchronize",
    "enqueued",
    "dequeued",
    "auto_merge_enabled",
    "auto_merge_disabled",
  ]) {
    const { deps, calls } = makeDeps();
    const res = await createHandler(deps)(depEvent("pull_request", depPr({ action })));
    assert.equal(res.statusCode, 202, action);
    assert.equal(dispatchCalls(calls).length, 1, action);
  }
});

test("dependabot 以外の作者・対象外の action・fork の head の PR は 202 で何もしない", async () => {
  const cases = [
    depPr({}, { user: { login: "someone" } }),
    depPr({ action: "labeled" }),
    depPr({ action: "edited" }),
    depPr({}, { head: { repo: { full_name: "other/pecot" } } }),
    depPr({ repository: { id: 1 } }),
  ];
  for (const payload of cases) {
    const { deps, calls } = makeDeps();
    const res = await createHandler(deps)(depEvent("pull_request", payload));
    assert.equal(res.statusCode, 202);
    assert.equal(calls.length, 0);
  }
});

test("dependabot/ の branch の completed な workflow_run は workflow を問わず dispatch する", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(
    depEvent("workflow_run", depRun({}, { name: "any-workflow" })),
  );
  assert.equal(res.statusCode, 202);
  assert.equal(dispatchCalls(calls).length, 1);
});

test("dependabot/ 以外の branch・completed 以外の workflow_run は 202 で何もしない", async () => {
  const cases = [
    depRun({}, { head_branch: "feat/x" }),
    depRun({}, { head_branch: "mydependabot/x" }),
    depRun({ action: "requested" }),
    depRun({ action: "in_progress" }),
  ];
  for (const payload of cases) {
    const { deps, calls } = makeDeps();
    const res = await createHandler(deps)(depEvent("workflow_run", payload));
    assert.equal(res.statusCode, 202);
    assert.equal(calls.length, 0);
  }
});

test("/dependabot-prs の ping は 200、security のイベントは 202 で何もしない", async () => {
  const { deps, calls } = makeDeps();
  const handler = createHandler(deps);
  assert.equal((await handler(depEvent("ping", { zen: "ok" }))).statusCode, 200);
  assert.equal((await handler(depEvent("dependabot_alert", alertPayload()))).statusCode, 202);
  assert.equal(calls.length, 0);
});

test("/security は dependabot-prs のイベントを dispatch しない", async () => {
  const { deps, calls } = makeDeps();
  const res = await createHandler(deps)(makeEvent("pull_request", depPr()));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 0);
});

test("token は App ごとに分けて使い回す", async () => {
  const { deps, calls } = makeDeps();
  const handler = createHandler(deps);
  await handler(makeEvent("dependabot_alert", alertPayload()));
  await handler(depEvent("pull_request", depPr()));
  await handler(makeEvent("dependabot_alert", alertPayload()));
  await handler(depEvent("pull_request", depPr()));
  const urls = calls.filter((c) => c.url.endsWith("/access_tokens")).map((c) => c.url);
  assert.deepEqual(urls, [
    "https://api.github.com/app/installations/777/access_tokens",
    "https://api.github.com/app/installations/888/access_tokens",
  ]);
});

test("片方の App の SSM が未設定でも、もう片方は動く", async () => {
  const { deps, calls } = makeDeps({ failSecretsFor: "dependabot-prs" });
  const handler = createHandler(deps);
  assert.equal((await handler(depEvent("pull_request", depPr()))).statusCode, 500);
  assert.equal((await handler(makeEvent("dependabot_alert", alertPayload()))).statusCode, 202);
  assert.equal(dispatchCalls(calls).length, 1);
});

test("Scheduler の固定の値で、署名なしに 2 つの workflow を起こす", async () => {
  const { deps, calls, logs } = makeDeps();
  const res = await createHandler(deps)(SCHEDULER_EVENT);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    dispatchCalls(calls).map((c) => c.url),
    [SECURITY_WORKFLOW_URL, DEPENDABOT_WORKFLOW_URL],
  );
  assert.deepEqual(logs, [
    { via: "scheduler", app: "security", run: 9001, result: "dispatched" },
    { via: "scheduler", app: "dependabot-prs", run: 9002, result: "dispatched" },
  ]);
});

test("requestContext.http があれば、Scheduler の値でも webhook として扱い署名なしは 401", async () => {
  const { deps, calls } = makeDeps();
  const raw = JSON.stringify(SCHEDULER_EVENT);
  for (const path of ["/security", "/dependabot-prs"]) {
    const res = await createHandler(deps)({
      ...SCHEDULER_EVENT,
      rawPath: path,
      requestContext: { http: { method: "POST" } },
      headers: {},
      body: raw,
    });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(calls.length, 0);
});

test("Scheduler の起動は片方が失敗しても、もう片方を起こし、例外を投げない", async () => {
  for (const failWorkflow of ["security-alerts.yml", "dependabot-prs.yml"]) {
    const { deps, calls, logs } = makeDeps({ failWorkflow });
    const res = await createHandler(deps)(SCHEDULER_EVENT);
    assert.equal(res.statusCode, 502);
    assert.equal(dispatchCalls(calls).length, 2);
    assert.equal(logs.filter((l) => l.result === "dispatch-error").length, 1);
    assert.equal(logs.filter((l) => l.result === "dispatched").length, 1);
  }
});

test("Scheduler の起動で片方の App の SSM が未設定でも、もう片方は起こす", async () => {
  const { deps, calls } = makeDeps({ failSecretsFor: "security" });
  const res = await createHandler(deps)(SCHEDULER_EVENT);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(
    dispatchCalls(calls).map((c) => c.url),
    [DEPENDABOT_WORKFLOW_URL],
  );
});

test("Scheduler でも webhook でもない event は、何もせずログだけ残す", async () => {
  for (const event of [{}, { source: "other" }, null, { source: "pecot-scheduler", requestContext: {} }]) {
    const { deps, calls, logs } = makeDeps();
    const res = await createHandler(deps)(event);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, [{ result: "unsupported-event" }]);
  }
});

test("Scheduler のログにも token が出ない", async () => {
  const { deps, logs } = makeDeps({ dispatchStatus: 500 });
  await createHandler(deps)(SCHEDULER_EVENT);
  assert.ok(!JSON.stringify(logs).includes("ghs_secret_token"));
});
