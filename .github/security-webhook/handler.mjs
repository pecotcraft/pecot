// GitHub App の webhook を受け、security alert の変化で security-alerts.yml を workflow_dispatch で起こす。
// AWS Lambda（nodejs24.x）の function URL（payload 2.0）で動く。依存は標準の crypto と fetch、ランタイム同梱の SSM の SDK だけ。
import { createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

const ALERT_EVENTS = new Set(["dependabot_alert", "code_scanning_alert", "secret_scanning_alert"]);
const API_BASE = "https://api.github.com";
const FETCH_TIMEOUT_MS = 4000;
const TOKEN_MARGIN_MS = 60_000;

const respond = (statusCode, body) => ({ statusCode, body });

const base64url = (input) => Buffer.from(input).toString("base64url");

/** ヘッダの名前を小文字にそろえ、body は生の Buffer にして返す。 */
export function normalizeRequest(event) {
  const headers = {};
  for (const [name, value] of Object.entries(event?.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  const raw = event?.body ?? "";
  const body = event?.isBase64Encoded ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
  return { headers, body };
}

/** x-hub-signature-256 を、生の body の HMAC-SHA256 と比べる。長さが違えば比べずに false を返す。 */
export function verifySignature(secret, body, header) {
  if (typeof header !== "string" || header === "") return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** 配送が dispatch の対象かを決める。対象外なら理由を返す。 */
export function selectEvent(eventName, payload, config) {
  if (eventName === "ping") return { dispatch: false, reason: "ping", status: 200 };
  if (!ALERT_EVENTS.has(eventName)) return { dispatch: false, reason: "ignored-event", status: 202 };
  if (String(payload?.repository?.id) !== String(config.repositoryId)) {
    return { dispatch: false, reason: "ignored-repository", status: 202 };
  }
  if (eventName === "code_scanning_alert" && payload?.ref !== `refs/heads/${config.dispatchRef}`) {
    return { dispatch: false, reason: "ignored-ref", status: 202 };
  }
  return { dispatch: true };
}

/** App の JWT（RS256）を作る。iss は Client ID。 */
export function createAppJwt(privateKey, clientId, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iat: iat - 60, exp: iat + 540, iss: clientId }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

const githubHeaders = (authorization) => ({
  Accept: "application/vnd.github+json",
  Authorization: authorization,
  "Content-Type": "application/json",
  "User-Agent": "pecot-security-webhook",
  "X-GitHub-Api-Version": "2022-11-28",
});

/** installation token を発行する。要求は対象リポと actions: write に絞る。 */
export async function requestInstallationToken({ fetchFn, jwt, installationId, repoName }) {
  const response = await fetchFn(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${jwt}`),
    body: JSON.stringify({ repositories: [repoName], permissions: { actions: "write" } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  const data = await response.json();
  return { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
}

/** workflow_dispatch を要求する。成功なら run の id（無ければ null）を返す。 */
export async function dispatchWorkflow({ fetchFn, token, repository, workflowFile, ref }) {
  const response = await fetchFn(
    `${API_BASE}/repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${token}`),
      body: JSON.stringify({ ref, return_run_details: true }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`dispatch failed: ${response.status}`);
  try {
    const data = await response.json();
    return data?.workflow_run_id ?? null;
  } catch {
    return null;
  }
}

/** SSM から鍵と webhook の secret を読む。SDK は読み出すときに初めて import する。 */
export async function loadSecretsFromSsm(env) {
  const { SSMClient, GetParametersCommand } = await import("@aws-sdk/client-ssm");
  const names = [env.SSM_PRIVATE_KEY_NAME, env.SSM_WEBHOOK_SECRET_NAME];
  const result = await new SSMClient({}).send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  const values = new Map((result.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const privateKeyPem = values.get(names[0]);
  const webhookSecret = values.get(names[1]);
  if (!privateKeyPem || !webhookSecret) throw new Error("ssm parameters missing");
  return { privateKeyPem, webhookSecret };
}

const readConfig = (env) => ({
  clientId: env.GITHUB_APP_CLIENT_ID,
  installationId: env.GITHUB_APP_INSTALLATION_ID,
  repositoryId: env.GITHUB_REPOSITORY_ID,
  repository: env.GITHUB_REPOSITORY,
  workflowFile: env.WORKFLOW_FILE,
  dispatchRef: env.DISPATCH_REF,
});

/** 依存（fetch・時刻・SSM の読み出し・環境変数・ログ）を差し替えられる handler を作る。 */
export function createHandler(deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const loadSecrets = deps.loadSecrets ?? loadSecretsFromSsm;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  // コールドスタートで 1 回だけ読む。失敗は持ち越さない。
  let secretsPromise = null;
  let cachedToken = null;

  const getSecrets = () => {
    if (!secretsPromise) {
      secretsPromise = loadSecrets(env)
        .then(({ privateKeyPem, webhookSecret }) => ({
          privateKey: createPrivateKey(privateKeyPem),
          webhookSecret,
        }))
        .catch((error) => {
          secretsPromise = null;
          throw error;
        });
    }
    return secretsPromise;
  };

  const getInstallationToken = async (config, privateKey) => {
    const nowMs = now();
    if (cachedToken && nowMs < cachedToken.expiresAtMs - TOKEN_MARGIN_MS) return cachedToken.token;
    const jwt = createAppJwt(privateKey, config.clientId, nowMs);
    const repoName = config.repository.split("/")[1];
    cachedToken = await requestInstallationToken({
      fetchFn,
      jwt,
      installationId: config.installationId,
      repoName,
    });
    return cachedToken.token;
  };

  return async (event) => {
    const config = readConfig(env);
    const { headers, body } = normalizeRequest(event);
    const eventName = headers["x-github-event"];

    let secrets;
    try {
      secrets = await getSecrets();
    } catch {
      log({ event: eventName, result: "secrets-error" });
      return respond(500, "internal error");
    }

    if (!verifySignature(secrets.webhookSecret, body, headers["x-hub-signature-256"])) {
      log({ event: eventName, result: "bad-signature" });
      return respond(401, "invalid signature");
    }

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      log({ event: eventName, result: "bad-json" });
      return respond(400, "invalid json");
    }

    const action = payload?.action;
    const alert = payload?.alert?.number;
    const selected = selectEvent(eventName, payload, config);
    if (!selected.dispatch) {
      log({ event: eventName, action, alert, result: selected.reason });
      return respond(selected.status, selected.reason);
    }

    try {
      const token = await getInstallationToken(config, secrets.privateKey);
      const runId = await dispatchWorkflow({
        fetchFn,
        token,
        repository: config.repository,
        workflowFile: config.workflowFile,
        ref: config.dispatchRef,
      });
      log({ event: eventName, action, alert, run: runId, result: "dispatched" });
      return respond(202, "dispatched");
    } catch {
      log({ event: eventName, action, alert, result: "dispatch-error" });
      return respond(502, "dispatch failed");
    }
  };
}

export const handler = createHandler();
