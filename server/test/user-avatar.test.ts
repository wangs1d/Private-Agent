import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 用户头像 HTTP 路由域（routes/http/user-avatar.ts）测试。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）+ 临时存储根：
 * - POST /api/user/avatar 上传 → 归一 webp 落盘 + current.json
 * - GET /api/user/avatar 查询 → avatarPath 回环
 * - GET /agent/avatars/:actorId/:fileName 拉流（Content-Type / 防穿越白名单）
 * - 二次上传替换旧文件、非法文件 400、缺 userId 400
 *
 * 运行：npx tsx --test test/user-avatar.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-avatar-test-"));

const { registerUserAvatarRoutes } = await import("../src/routes/http/user-avatar.js");
const { default: Fastify } = await import("fastify");
const multipartPlugin = await import("@fastify/multipart");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function buildApp(): Promise<{ app: Awaited<ReturnType<typeof Fastify>>; rootDir: string }> {
  const rootDir = path.join(tmpDir, `store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const app = Fastify();
  await app.register(multipartPlugin.default);
  registerUserAvatarRoutes(app, { rootDir });
  await app.ready();
  return { app, rootDir };
}

/** 手拼 multipart body（避免引入 form-data 依赖）。 */
function multipartBody(fieldName: string, fileName: string, mime: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Math.random().toString(36).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test("用户头像：上传→查询→拉流 roundtrip，二次上传删旧文件", async () => {
  const { app, rootDir } = await buildApp();
  try {
    // 无头像时查询 → null
    const empty = await app.inject({ method: "GET", url: "/api/user/avatar?userId=user@test.com" });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().avatarPath, null);

    // 上传 1x1 PNG（@ 走 sanitizeActorKey 原样保留）
    const first = multipartBody("file", "a.png", "image/png", PNG_1PX);
    const up1 = await app.inject({
      method: "POST",
      url: "/api/user/avatar?userId=user@test.com",
      headers: { "content-type": first.contentType },
      payload: first.body,
    });
    assert.equal(up1.statusCode, 200);
    const up1Body = up1.json();
    assert.equal(up1Body.ok, true);
    const path1: string = up1Body.avatarPath;
    assert.match(path1, /^\/agent\/avatars\/user@test\.com\/[0-9a-f-]{36}\.webp$/);

    // 查询回环一致
    const meta = await app.inject({ method: "GET", url: "/api/user/avatar?userId=user@test.com" });
    assert.equal(meta.json().avatarPath, path1);
    assert.ok(typeof meta.json().updatedAt === "string" && meta.json().updatedAt.length > 0);

    // 落盘校验：归一 webp + current.json
    const actorDir = path.join(rootDir, "user@test.com");
    assert.ok(fs.existsSync(path.join(actorDir, "current.json")));
    const files1 = fs.readdirSync(actorDir).filter((f) => f.endsWith(".webp"));
    assert.equal(files1.length, 1);
    const onDisk = fs.readFileSync(path.join(actorDir, files1[0]));
    assert.equal(onDisk.subarray(0, 4).toString("ascii"), "RIFF", "归一产物应为 webp 容器");

    // 拉流：200 + image/webp
    const served = await app.inject({ method: "GET", url: path1 });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers["content-type"], "image/webp");
    assert.ok(served.headers["cache-control"]?.includes("immutable"));
    assert.ok(served.rawPayload.length > 0);

    // 二次上传：URL 变化 + 旧文件被删
    const second = multipartBody("file", "b.png", "image/png", PNG_1PX);
    const up2 = await app.inject({
      method: "POST",
      url: "/api/user/avatar?userId=user@test.com",
      headers: { "content-type": second.contentType },
      payload: second.body,
    });
    assert.equal(up2.statusCode, 200);
    const path2: string = up2.json().avatarPath;
    assert.notEqual(path2, path1);
    const files2 = fs.readdirSync(actorDir).filter((f) => f.endsWith(".webp"));
    assert.equal(files2.length, 1, "旧头像应被删除");
    // 旧 URL 拉不到
    const stale = await app.inject({ method: "GET", url: path1 });
    assert.equal(stale.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("用户头像：非法文件 / 缺文件 / 缺 userId / 防穿越", async () => {
  const { app } = await buildApp();
  try {
    // 非图片内容 → 400
    const bad = multipartBody("file", "x.png", "image/png", Buffer.from("这不是图片"));
    const badRes = await app.inject({
      method: "POST",
      url: "/api/user/avatar?userId=user@test.com",
      headers: { "content-type": bad.contentType },
      payload: bad.body,
    });
    assert.equal(badRes.statusCode, 400);

    // 缺文件字段 → 400
    const emptyBoundary = "----testboundary-empty";
    const emptyRes = await app.inject({
      method: "POST",
      url: "/api/user/avatar?userId=user@test.com",
      headers: { "content-type": `multipart/form-data; boundary=${emptyBoundary}` },
      payload: Buffer.from(`--${emptyBoundary}--\r\n`),
    });
    assert.equal(emptyRes.statusCode, 400);

    // 缺 userId → 400（匿名哨兵不放行）
    const noUser = multipartBody("file", "a.png", "image/png", PNG_1PX);
    const noUserRes = await app.inject({
      method: "POST",
      url: "/api/user/avatar",
      headers: { "content-type": noUser.contentType },
      payload: noUser.body,
    });
    assert.equal(noUserRes.statusCode, 400);

    // 拉流防穿越：路径穿越 / 非 webp 白名单 → 404
    const traversal = await app.inject({
      method: "GET",
      url: "/agent/avatars/user@test.com/%2e%2e%2f%2e%2e%2fsecrets.png",
    });
    assert.equal(traversal.statusCode, 404);
    const wrongExt = await app.inject({
      method: "GET",
      url: "/agent/avatars/user@test.com/abc.png",
    });
    assert.equal(wrongExt.statusCode, 404);
    const missing = await app.inject({
      method: "GET",
      url: "/agent/avatars/user@test.com/00000000-0000-4000-8000-000000000000.webp",
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});
