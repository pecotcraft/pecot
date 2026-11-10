// 2 つの GitHub App の webhook と EventBridge Scheduler の起動を受け、Tracker をそろえる workflow を起こす。
// 依存は標準の crypto と fetch、Lambda のランタイムに同梱の SSM の SDK だけ。
import { createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

const ALERT_EVENTS = new Set(["dependabot_alert", "code_scanning_alert", "secret_scanning_alert"]);
const DEPENDABOT_PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "closed",
  "synchronize",
  "enqueued",
  "dequeued",
  "auto_merge_enabled",
  "auto_merge_disabled",
]);
const DEPENDABOT_LOGIN = "dependabot[bot]";
const APPS = {
  security: { path: "/security", prefix: "SECURITY_" },
  "dependabot-prs": { path: "/dependabot-prs", prefix: "DEPENDABOT_PRS_" },
};
const APP_BY_PATH = new Map(Object.entries(APPS).map(([name, app]) => [app.path, name]));
const SCHEDULER_SOURCE = "pecot-scheduler";
const DEPENDABOT_EVENTS = new Set(["pull_request", "workflow_run"]);
const API_BASE = "https://api.github.com";
const FETCH_TIMEOUT_MS = 4000;
const SSM_TIMEOUT_MS = 3000;
const SSM_CONNECT_TIMEOUT_MS = 1000;
const SSM_MAX_ATTEMPTS = 2;
const TOKEN_MARGIN_MS = 60_000;
// GitHub の文書上、この 2 つの action では code_scanning_alert の ref が空になる。
const REF_LESS_ACTIONS = new Set(["closed_by_user", "reopened_by_user"]);

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
export function selectEvent(appName, eventName, payload, config) {
  if (eventName === "ping") return { dispatch: false, reason: "ping", status: 200 };
  const ignored = (reason) => ({ dispatch: false, reason, status: 202 });
  const events = appName === "security" ? ALERT_EVENTS : DEPENDABOT_EVENTS;
  if (!events.has(eventName)) return ignored("ignored-event");
  if (String(payload?.repository?.id) !== String(config.repositoryId)) {
    return ignored("ignored-repository");
  }
  if (appName === "security") {
    if (
      eventName === "code_scanning_alert" &&
      !REF_LESS_ACTIONS.has(payload?.action) &&
      payload?.ref !== `refs/heads/${config.dispatchRef}`
    ) {
      return ignored("ignored-ref");
    }
    return { dispatch: true };
  }
  if (eventName === "pull_request") {
    const pr = payload?.pull_request;
    if (pr?.user?.login !== DEPENDABOT_LOGIN) return ignored("ignored-author");
    if (pr?.head?.repo?.full_name !== config.repository) return ignored("ignored-head");
    if (!DEPENDABOT_PR_ACTIONS.has(payload?.action)) return ignored("ignored-action");
    return { dispatch: true };
  }
  if (payload?.action !== "completed") return ignored("ignored-action");
  if (!String(payload?.workflow_run?.head_branch ?? "").startsWith("dependabot/")) {
    return ignored("ignored-branch");
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
  "User-Agent": "pecot-board-sync",
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
  if (!response.ok) {
    throw Object.assign(new Error(`token request failed: ${response.status}`), {
      status: response.status,
    });
  }
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
  if (!response.ok) {
    throw Object.assign(new Error(`dispatch failed: ${response.status}`), {
      status: response.status,
    });
  }
  try {
    const data = await response.json();
    return data?.workflow_run_id ?? null;
  } catch {
    return null;
  }
}

/** SSM から App の鍵と webhook の secret を読む。SDK は読み出すときに初めて import する。 */
export async function loadSecretsFromSsm(env, appName, sdk) {
  const { SSMClient, GetParametersCommand } = sdk ?? (await import("@aws-sdk/client-ssm"));
  const { prefix } = APPS[appName];
  const names = [env[`${prefix}SSM_PRIVATE_KEY_NAME`], env[`${prefix}SSM_WEBHOOK_SECRET_NAME`]];
  const client = new SSMClient({
    requestHandler: { requestTimeout: SSM_TIMEOUT_MS, connectionTimeout: SSM_CONNECT_TIMEOUT_MS },
    maxAttempts: SSM_MAX_ATTEMPTS,
  });
  const result = await client.send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  const values = new Map((result.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const privateKeyPem = values.get(names[0]);
  const webhookSecret = values.get(names[1]);
  if (!privateKeyPem || !webhookSecret) throw new Error("ssm parameters missing");
  return { privateKeyPem, webhookSecret };
}

/** ログに出す失敗の情報は stage と数値の status だけにする。message は出さない。 */
const failureFields = (stage, error) => {
  const status = error?.status ?? error?.$metadata?.httpStatusCode;
  return Number.isInteger(status) ? { stage, status } : { stage };
};

const withStage = async (stage, work) => {
  try {
    return await work();
  } catch (error) {
    if (error && typeof error === "object" && !error.stage) error.stage = stage;
    throw error;
  }
};

const readConfig = (env, appName) => {
  const { prefix } = APPS[appName];
  return {
    clientId: env[`${prefix}APP_CLIENT_ID`],
    installationId: env[`${prefix}APP_INSTALLATION_ID`],
    workflowFile: env[`${prefix}WORKFLOW_FILE`],
    repositoryId: env.GITHUB_REPOSITORY_ID,
    repository: env.GITHUB_REPOSITORY,
    dispatchRef: env.DISPATCH_REF,
  };
};

/** 依存（fetch・時刻・SSM の読み出し・環境変数・ログ）を差し替えられる handler を作る。 */
export function createHandler(deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const loadSecrets = deps.loadSecrets ?? loadSecretsFromSsm;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  // App ごとに、コールドスタートで 1 回だけ鍵を読む。失敗は持ち越さない。
  const secretsPromises = new Map();
  const cachedTokens = new Map();

  const getSecrets = (appName) => {
    if (!secretsPromises.has(appName)) {
      const promise = loadSecrets(env, appName)
        .then(({ privateKeyPem, webhookSecret }) => ({
          privateKey: createPrivateKey(privateKeyPem),
          webhookSecret,
        }))
        .catch((error) => {
          secretsPromises.delete(appName);
          throw error;
        });
      secretsPromises.set(appName, promise);
    }
    return secretsPromises.get(appName);
  };

  const getInstallationToken = async (appName, config, privateKey) => {
    const nowMs = now();
    const cached = cachedTokens.get(appName);
    if (cached && nowMs < cached.expiresAtMs - TOKEN_MARGIN_MS) return cached.token;
    const jwt = createAppJwt(privateKey, config.clientId, nowMs);
    const repoName = config.repository.split("/")[1];
    const fresh = await requestInstallationToken({
      fetchFn,
      jwt,
      installationId: config.installationId,
      repoName,
    });
    cachedTokens.set(appName, fresh);
    return fresh.token;
  };

  const dispatchFor = async (appName, secrets) => {
    const config = readConfig(env, appName);
    const send = async () => {
      const token = await withStage("token", () =>
        getInstallationToken(appName, config, secrets.privateKey),
      );
      return withStage("dispatch", () =>
        dispatchWorkflow({
          fetchFn,
          token,
          repository: config.repository,
          workflowFile: config.workflowFile,
          ref: config.dispatchRef,
        }),
      );
    };
    try {
      return await send();
    } catch (error) {
      // 失効した token の 401 は、キャッシュを捨てて 1 回だけやり直す。
      if (error?.stage !== "dispatch" || error.status !== 401) throw error;
      cachedTokens.delete(appName);
      return send();
    }
  };

  // 2 つの workflow を並列に起こす。片方が失敗してももう片方は起こし、
  // 非同期の起動では返り値が Errors に数えられないので、両方終えてから throw する。
  const handleScheduler = async () => {
    const results = await Promise.allSettled(
      Object.keys(APPS).map(async (appName) => {
        const secrets = await withStage("secrets", () => getSecrets(appName));
        const runId = await dispatchFor(appName, secrets);
        log({ via: "scheduler", app: appName, run: runId, result: "dispatched" });
      }),
    );
    let failed = false;
    results.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") return;
      failed = true;
      const appName = Object.keys(APPS)[i];
      const { reason } = outcome;
      log({
        via: "scheduler",
        app: appName,
        result: "dispatch-error",
        ...failureFields(reason?.stage ?? "dispatch", reason),
      });
    });
    if (failed) throw new Error("dispatch failed");
    return respond(200, "dispatched");
  };

  const handleWebhook = async (event) => {
    const http = event.requestContext.http;
    const appName = http.method === "POST" ? APP_BY_PATH.get(event.rawPath) : undefined;
    if (!appName) {
      log({ via: "url", result: "not-found" });
      return respond(404, "not found");
    }
    const { headers, body } = normalizeRequest(event);
    const eventName = headers["x-github-event"];
    const base = { via: "url", app: appName, event: eventName };

    let secrets;
    try {
      secrets = await getSecrets(appName);
    } catch (error) {
      log({ ...base, result: "secrets-error", ...failureFields("secrets", error) });
      return respond(500, "internal error");
    }

    if (!verifySignature(secrets.webhookSecret, body, headers["x-hub-signature-256"])) {
      log({ ...base, result: "bad-signature" });
      return respond(401, "invalid signature");
    }

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      log({ ...base, result: "bad-json" });
      return respond(400, "invalid json");
    }

    const action = payload?.action;
    const alert = payload?.alert?.number;
    const selected = selectEvent(appName, eventName, payload, readConfig(env, appName));
    if (!selected.dispatch) {
      log({ ...base, action, alert, result: selected.reason });
      return respond(selected.status, selected.reason);
    }

    try {
      const runId = await dispatchFor(appName, secrets);
      log({ ...base, action, alert, run: runId, result: "dispatched" });
      return respond(202, "dispatched");
    } catch (error) {
      log({
        ...base,
        action,
        alert,
        result: "dispatch-error",
        ...failureFields(error?.stage ?? "dispatch", error),
      });
      return respond(502, "dispatch failed");
    }
  };

  return async (event) => {
    if (event?.requestContext?.http) return handleWebhook(event);
    if (!event?.requestContext && event?.source === SCHEDULER_SOURCE) return handleScheduler();
    log({ result: "unsupported-event" });
    return respond(400, "unsupported event");
  };
}

export const handler = createHandler();
