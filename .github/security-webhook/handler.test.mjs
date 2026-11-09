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
const ENV = {
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_INSTALLATION_ID: "777",
  GITHUB_REPOSITORY_ID: "4242",
  GITHUB_REPOSITORY: "pecotcraft/pecot",
  WORKFLOW_FILE: "security-alerts.yml",
  DISPATCH_REF: "main",
};
const NOW = Date.parse("2026-11-09T00:00:00Z");

const sign = (body, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

/** fetch の呼び出しを記録し、URL に応じた応答を返す。 */
function makeDeps({ dispatchStatus = 200, tokenStatus = 201, now = () => NOW } = {}) {
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
    return jsonResponse(dispatchStatus, { workflow_run_id: 9001 });
  };
  const deps = {
    fetch: fetchFn,
    now,
    env: ENV,
    log: (entry) => logs.push(entry),
    loadSecrets: async () => {
      secretsLoads.push(1);
      return { privateKeyPem: privateKey, webhookSecret: SECRET };
    },
  };
  return { deps, calls, logs, secretsLoads };
}

function makeEvent(eventName, payload, { signature, base64 = false } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { "X-GitHub-Event": eventName, "X-Hub-Signature-256": signature ?? sign(raw) };
  return {
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
  assert.equal(
    dispatch.url,
    "https://api.github.com/repos/pecotcraft/pecot/actions/workflows/security-alerts.yml/dispatches",
  );
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: "main", return_run_details: true });
  assert.equal(dispatch.init.method, "POST");
  assert.equal(dispatch.init.headers.Authorization, "Bearer ghs_secret_token");
  assert.equal(dispatch.init.headers.Accept, "application/vnd.github+json");
  assert.equal(dispatch.init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(dispatch.init.headers["User-Agent"], "pecot-security-webhook");
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
  assert.equal(tokenCall.init.headers["User-Agent"], "pecot-security-webhook");

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

test("SSM の読み出しはコールドスタートで 1 回だけ", async () => {
  const { deps, secretsLoads } = makeDeps();
  const handler = createHandler(deps);
  await handler(makeEvent("ping", {}));
  await handler(makeEvent("ping", {}));
  assert.equal(secretsLoads.length, 1);
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
    { event: "dependabot_alert", action: "created", alert: 12, run: 9001, result: "dispatched" },
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
