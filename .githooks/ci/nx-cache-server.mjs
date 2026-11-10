// nx の self-hosted HTTP リモートキャッシュ（GET/PUT /v1/cache/{hash}）を、ディレクトリ 1 つで受ける。
// 引数は --dir --port-file と任意の --used-file、token は env NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN。
import { createServer } from "node:http";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = arg("dir");
const portFile = arg("port-file");
const usedFile = arg("used-file");
const token = process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN ?? "";
if (!dir || !portFile || !token) {
  console.error("使い方: nx-cache-server.mjs --dir=<dir> --port-file=<file>（token は env）");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const used = new Set();
const counts = { hit: 0, miss: 0, put: 0, conflict: 0 };
const route = /^\/v1\/cache\/([^/]+)$/;
const hashOk = /^[A-Za-z0-9]+$/;

const reply = (res, status) => {
  res.writeHead(status, { "content-length": 0 });
  res.end();
};

const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) {
      req.resume();
      return reply(res, 401);
    }
    const hash = route.exec(req.url ?? "")?.[1];
    if (hash === undefined) {
      req.resume();
      return reply(res, 404);
    }
    if (!hashOk.test(hash)) {
      req.resume();
      return reply(res, 400);
    }
    const target = join(dir, `${hash}.tar.gz`);
    if (req.method === "GET") {
      if (!existsSync(target)) {
        counts.miss++;
        return reply(res, 404);
      }
      counts.hit++;
      used.add(hash);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return await pipeline(createReadStream(target), res);
    }
    if (req.method === "PUT") {
      if (existsSync(target)) {
        counts.conflict++;
        req.resume();
        return reply(res, 409);
      }
      const tmp = join(dir, `.${hash}.${randomBytes(6).toString("hex")}.tmp`);
      let status;
      try {
        await pipeline(req, createWriteStream(tmp));
        // link は既存だと EEXIST で失敗するので、同時の PUT でも先に書いたものが勝つ。
        const won = await link(tmp, target).then(
          () => true,
          (e) => {
            if (e.code === "EEXIST") return false;
            throw e;
          },
        );
        if (won) {
          counts.put++;
          used.add(hash);
        } else counts.conflict++;
        status = won ? 200 : 409;
      } finally {
        await unlink(tmp).catch(() => {});
      }
      return reply(res, status);
    }
    req.resume();
    return reply(res, 405);
  } catch (e) {
    console.error(`nx-cache-server: ${e}`);
    if (!res.headersSent) reply(res, 500);
    else res.destroy();
  }
});

server.listen(0, "127.0.0.1", () => {
  const tmp = `${portFile}.tmp`;
  writeFileSync(tmp, `${server.address().port}\n`);
  renameSync(tmp, portFile);
});

process.on("SIGTERM", () => {
  try {
    const stored = readdirSync(dir).filter((f) => f.endsWith(".tar.gz")).length;
    console.log(
      `nx-cache-server: GET hit=${counts.hit} miss=${counts.miss} PUT=${counts.put} conflict=${counts.conflict} 保存=${stored}`,
    );
  } catch (e) {
    console.error(`nx-cache-server: 集計に失敗: ${e}`);
  }
  if (usedFile) {
    try {
      const tmp = `${usedFile}.tmp`;
      writeFileSync(tmp, [...used].map((h) => `${h}\n`).join(""));
      renameSync(tmp, usedFile);
    } catch (e) {
      console.error(`nx-cache-server: used-file の書き込みに失敗: ${e}`);
    }
  }
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
