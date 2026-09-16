/**
 * FriendService 单测：SQLite 存储改造 + 好友策略补齐。
 *
 * 覆盖：
 *   1. 好友请求全流程（发送 / 接受 / 拒绝 / 取消）与双向好友关系
 *   2. 自动同意开关：开启后请求即时接受（autoAccepted），关闭恢复人工响应
 *   3. 好友上限：发起方与目标方分别拦截
 *   4. friendshipStatus 状态机（发现/搜索标注用）
 *   5. 旧 agent-friends.json 一次性迁移（导入 + 改名 *.imported.bak）
 *   6. SQLite 持久化：跨实例（重启）恢复
 *   7. AgentAccountService.searchAccounts：子串搜索 / 排除自己 / 跳过 disabled / limit
 *
 * 测试封闭：临时目录 SQLite + 临时 JSON，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FriendService } from "../src/services/friend-service.js";
import { AgentAccountService } from "../src/services/agent-account-service.js";

interface Ctx {
  dir: string;
  service: FriendService;
}

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  opts?: { maxFriendsPerActor?: number }
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "friend-service-"));
  const service = new FriendService({
    dbPath: join(dir, "friends.db"),
    legacyJsonPath: join(dir, "agent-friends.json"),
    ...(opts?.maxFriendsPerActor !== undefined ? { maxFriendsPerActor: opts.maxFriendsPerActor } : {}),
  });
  await service.load();
  try {
    await fn({ dir, service });
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("好友请求全流程：发送 → 接受 → 双向好友", async () => {
  await withService(async ({ service }) => {
    const sent = await service.sendFriendRequest("alice", "bob", "交个朋友");
    assert.ok(sent.ok);
    assert.equal(sent.request.status, "pending");
    assert.equal(sent.autoAccepted, undefined);
    assert.equal(service.friendshipStatus("alice", "bob"), "outgoing_pending");
    assert.equal(service.friendshipStatus("bob", "alice"), "incoming_pending");

    // 重复发送被拦截
    const dup = await service.sendFriendRequest("alice", "bob");
    assert.ok(!dup.ok);

    // 无权响应：非目标本人
    const wrong = await service.respondToRequest(sent.request.requestId, "carol", true);
    assert.ok(!wrong.ok);

    const responded = await service.respondToRequest(sent.request.requestId, "bob", true);
    assert.ok(responded.ok);
    assert.equal(responded.request?.status, "accepted");

    assert.ok(service.areFriends("alice", "bob"));
    assert.ok(service.areFriends("bob", "alice"));
    assert.equal(service.friendshipStatus("alice", "bob"), "friends");
    assert.deepEqual(service.getFriends("alice").map((f) => f.friendActorId), ["bob"]);

    // 已是好友后再发被拦截
    const again = await service.sendFriendRequest("bob", "alice");
    assert.ok(!again.ok);
  });
});

test("拒绝与取消", async () => {
  await withService(async ({ service }) => {
    const sent = await service.sendFriendRequest("alice", "bob");
    assert.ok(sent.ok);

    const rejected = await service.respondToRequest(sent.request.requestId, "bob", false);
    assert.ok(rejected.ok);
    assert.equal(rejected.request?.status, "rejected");
    assert.ok(!service.areFriends("alice", "bob"));

    // rejected 后可重新发起
    const resent = await service.sendFriendRequest("alice", "bob");
    assert.ok(resent.ok);
    const cancelled = await service.cancelRequest(resent.request.requestId, "alice");
    assert.ok(cancelled.ok);
    assert.equal(service.getIncomingRequests("bob").length, 0);
    assert.equal(service.getOutgoingRequests("alice").length, 0);
    assert.equal(service.getAllRequests("alice").length, 2);
  });
});

test("自动同意：开启后请求即时接受，关闭恢复 pending", async () => {
  await withService(async ({ service }) => {
    assert.equal(service.isAutoAccept("agent-1"), false);
    service.setAutoAccept("agent-1", true);
    assert.equal(service.isAutoAccept("agent-1"), true);

    const sent = await service.sendFriendRequest("alice", "agent-1", "hi bot");
    assert.ok(sent.ok);
    assert.equal(sent.autoAccepted, true);
    assert.equal(sent.request.status, "accepted");
    assert.ok(service.areFriends("alice", "agent-1"));
    // 无 pending 残留
    assert.equal(service.getIncomingRequests("agent-1").length, 0);

    // 关闭后恢复人工响应
    service.setAutoAccept("agent-1", false);
    const sent2 = await service.sendFriendRequest("carol", "agent-1");
    assert.ok(sent2.ok);
    assert.equal(sent2.autoAccepted, undefined);
    assert.equal(sent2.request.status, "pending");
  });
});

test("好友上限：发起方与目标方分别拦截", async () => {
  await withService(
    async ({ service }) => {
      // 发起方满：alice 与 bob、carol 相继成为好友后到达上限 2，第三个请求被拦截
      const r1 = await service.sendFriendRequest("alice", "bob");
      assert.ok(r1.ok);
      await service.respondToRequest(r1.request.requestId, "bob", true);
      const r2 = await service.sendFriendRequest("alice", "carol");
      assert.ok(r2.ok);
      await service.respondToRequest(r2.request.requestId, "carol", true);
      const r3 = await service.sendFriendRequest("alice", "dave");
      assert.ok(!r3.ok);
      assert.match(r3.reason, /你的好友数量已达上限/);

      // 目标方满：bob 再收下 eve 到达上限 2，frank 的请求按目标方拦截
      const r4 = await service.sendFriendRequest("eve", "bob");
      assert.ok(r4.ok);
      const responded = await service.respondToRequest(r4.request.requestId, "bob", true);
      assert.ok(responded.ok);
      const r5 = await service.sendFriendRequest("frank", "bob");
      assert.ok(!r5.ok);
      assert.match(r5.reason, /对方好友数量已达上限/);

      // pending 请求不计入上限：carol(1/2)→dave(0/2) 可正常发出
      const r6 = await service.sendFriendRequest("carol", "dave");
      assert.ok(r6.ok);
    },
    { maxFriendsPerActor: 2 }
  );
});

test("旧 JSON 一次性迁移：导入 + 改名 *.imported.bak", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friend-migrate-"));
  try {
    const legacyPath = join(dir, "agent-friends.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        requests: [
          {
            requestId: "fr_legacy01",
            fromActorId: "alice",
            toActorId: "bob",
            status: "accepted",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        friends: [{ actorId: "alice", friendActorId: "bob", addedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      "utf8"
    );

    const service = new FriendService({
      dbPath: join(dir, "friends.db"),
      legacyJsonPath: legacyPath,
    });
    await service.load();
    try {
      assert.ok(service.areFriends("alice", "bob"));
      assert.equal(service.getAllRequests("alice").length, 1);
      // 旧文件已改名留存
      await access(`${legacyPath}.imported.bak`, constants.F_OK);
      let gone = false;
      try {
        await access(legacyPath, constants.F_OK);
      } catch {
        gone = true;
      }
      assert.ok(gone, "旧 JSON 应已改名");
    } finally {
      service.close();
    }

    // 二次启动：表非空，不重复导入（且无旧文件可读，也不报错）
    const service2 = new FriendService({
      dbPath: join(dir, "friends.db"),
      legacyJsonPath: legacyPath,
    });
    await service2.load();
    try {
      assert.ok(service2.areFriends("alice", "bob"));
    } finally {
      service2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite 持久化：跨实例（重启）恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friend-restart-"));
  try {
    const dbPath = join(dir, "friends.db");
    const s1 = new FriendService({ dbPath, legacyJsonPath: join(dir, "no-legacy.json") });
    await s1.load();
    s1.setAutoAccept("agent-9", true);
    const sent = await s1.sendFriendRequest("alice", "agent-9");
    assert.ok(sent.ok);
    s1.close();

    const s2 = new FriendService({ dbPath, legacyJsonPath: join(dir, "no-legacy.json") });
    await s2.load();
    try {
      assert.ok(s2.areFriends("alice", "agent-9"));
      assert.equal(s2.isAutoAccept("agent-9"), true);
      assert.equal(s2.getAllRequests("alice")[0]?.requestId, sent.request.requestId);
    } finally {
      s2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateLastMessageTime 更新且不影响其他好友", async () => {
  await withService(async ({ service }) => {
    const a = await service.sendFriendRequest("alice", "bob");
    const b = await service.sendFriendRequest("alice", "carol");
    assert.ok(a.ok && b.ok);
    const ra = await service.respondToRequest(a.request.requestId, "bob", true);
    const rb = await service.respondToRequest(b.request.requestId, "carol", true);
    assert.ok(ra.ok && rb.ok);

    await service.updateLastMessageTime("alice", "bob");
    const friends = service.getFriends("alice");
    const bob = friends.find((f) => f.friendActorId === "bob");
    const carol = friends.find((f) => f.friendActorId === "carol");
    assert.ok(bob?.lastMessageAt);
    assert.ok(!carol?.lastMessageAt);
  });
});

test("searchAccounts：子串搜索 / 排除自己 / 跳过 disabled / limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friend-search-"));
  try {
    process.env.AGENT_ACCOUNTS_FILE = join(dir, "accounts.json");
    const accounts = new AgentAccountService();
    await accounts.load();
    await accounts.register("alice", "Alice 小爱");
    await accounts.register("bob", "Bob 小波");
    await accounts.register("carol", "Carol 卡罗", "carol@mail.com");
    await accounts.register("agent-official", "官方助手 Agent");
    await accounts.setDisabled("agent-official", true);

    // 昵称子串（大小写不敏感）
    assert.deepEqual(accounts.searchAccounts({ q: "小波" }).map((a) => a.userId), ["bob"]);
    // 邮箱命中
    assert.deepEqual(accounts.searchAccounts({ q: "MAIL.COM" }).map((a) => a.userId), ["carol"]);
    // userId 命中
    assert.deepEqual(accounts.searchAccounts({ q: "ali" }).map((a) => a.userId), ["alice"]);
    // disabled 不出现
    assert.ok(!accounts.searchAccounts({ q: "官方" }).some((a) => a.userId === "agent-official"));
    // 排除自己
    assert.ok(
      !accounts.searchAccounts({ q: "", excludeActorId: "alice" }).some((a) => a.userId === "alice")
    );
    // 浏览模式（q 空）+ limit：返回 2 条、不含 disabled 账号
    const browse = accounts.searchAccounts({ q: "", excludeActorId: "agent-official", limit: 2 });
    assert.equal(browse.length, 2);
    assert.ok(browse.every((a) => ["alice", "bob", "carol"].includes(a.userId)));
  } finally {
    delete process.env.AGENT_ACCOUNTS_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});
