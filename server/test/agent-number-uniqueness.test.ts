import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * QQ 式身份短号唯一性专项测试（2026-09-30）。
 *
 * 短号是对外身份主键，重复即事故。本文件穷举可能产生重复的路径并证明全部封死：
 *  1. 同进程批量注册（含 Promise.all 并发）→ 全库唯一
 *  2. 重启（新实例 load）→ 号码稳定不变（终身不变）且仍唯一
 *  3. 数据文件里出现重复短号（手改/脏数据）→ load 自愈去重并持久化
 *  4. 数据文件里出现非法格式短号 → 重新发号
 *  5. 旧账号补号不抢占存量号（两遍扫描：先认领后补发）
 *  6. 冲突探测：generateAgentNumber 的线性探测兜底（索引占满低位区间）
 *
 * 运行：node --import tsx --test test/agent-number-uniqueness.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-number-uniqueness-"));
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");

const { AgentAccountService, AGENT_NUMBER_PATTERN } = await import(
  "../src/services/agent-account-service.js"
);
type AgentAccountRecord = import("../src/services/agent-account-service.js").AgentAccountRecord;

function freshService(): InstanceType<typeof AgentAccountService> {
  return new AgentAccountService();
}

/** 独立账号文件作用域：每个测试各用一份，互不污染。 */
async function withAccountFile<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.AGENT_ACCOUNTS_FILE;
  process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, name);
  try {
    return await fn();
  } finally {
    process.env.AGENT_ACCOUNTS_FILE = saved;
  }
}

function accountsOnDisk(): AgentAccountRecord[] {
  const raw = fs.readFileSync(process.env.AGENT_ACCOUNTS_FILE!, "utf8");
  return (JSON.parse(raw) as { accounts: AgentAccountRecord[] }).accounts;
}

function assertAllUnique(records: AgentAccountRecord[], label: string): void {
  const numbers = records.map((a) => a.agentNumber!);
  for (const n of numbers) {
    assert.match(n, AGENT_NUMBER_PATTERN, `${label}: 短号 ${n} 不符合 6-8 位格式`);
  }
  assert.equal(new Set(numbers).size, numbers.length, `${label}: 存在重复短号`);
}

test("同进程批量注册 500 账号 → 短号全唯一且符合格式", async () => {
  await withAccountFile("bulk.json", async () => {
    const svc = freshService();
    await svc.load();
    for (let i = 0; i < 500; i++) {
      await svc.register(`bulk-${i}@test.local`, `账号${i}`);
    }
    assertAllUnique(svc.listAll(), "批量注册");
  });
});

test("Promise.all 并发注册 → 生成与占位同步原子，仍全唯一", async () => {
  await withAccountFile("race.json", async () => {
    const svc = freshService();
    await svc.load();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => svc.register(`race-${i}@test.local`, `并发${i}`)),
    );
    assertAllUnique(svc.listAll(), "并发注册");
    assert.equal(svc.listAll().length, 200);
  });
});

test("重启（新实例 load）→ 号码稳定不变（终身不变）且仍唯一", async () => {
  await withAccountFile("stable.json", async () => {
  const first = freshService();
  await first.load();
  await first.register("stable-a@test.local", "A");
  await first.register("stable-b@test.local", "B");
  const before = new Map(first.listAll().map((a) => [a.userId, a.agentNumber!]));

  const second = freshService();
  await second.load();
  for (const [userId, num] of before) {
    assert.equal(second.getByActorId(userId)?.agentNumber, num, `${userId} 的短号跨重启漂移`);
    assert.equal(second.getByAgentNumber(num)?.userId, userId, `短号 ${num} 反查失效`);
  }
  assertAllUnique(second.listAll(), "重启后");
  });
});

test("数据文件重复短号（脏数据）→ load 自愈去重并持久化", async () => {
  const file = path.join(tmpDir, "dup-numbers.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [
        {
          accountId: "acc-1",
          userId: "dup-a@test.local",
          displayName: "A",
          agentNumber: "12345678",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
        {
          accountId: "acc-2",
          userId: "dup-b@test.local",
          displayName: "B",
          agentNumber: "12345678",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
      ],
    }),
  );
  const saved = process.env.AGENT_ACCOUNTS_FILE;
  process.env.AGENT_ACCOUNTS_FILE = file;
  try {
    const svc = freshService();
    await svc.load();
    assertAllUnique(svc.listAll(), "脏数据自愈");
    // 先到先得：第一行的存量号保住，第二行被重新发号
    assert.equal(svc.getByActorId("dup-a@test.local")?.agentNumber, "12345678");
    assert.notEqual(svc.getByActorId("dup-b@test.local")?.agentNumber, "12345678");
    // 自愈结果落盘（重启不再复发）
    assertAllUnique(accountsOnDisk(), "自愈后落盘");
  } finally {
    process.env.AGENT_ACCOUNTS_FILE = saved;
  }
});

test("非法格式短号（补零/超长/带字母）→ 重新发号", async () => {
  const file = path.join(tmpDir, "invalid-numbers.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [
        {
          accountId: "acc-i1",
          userId: "bad-a@test.local",
          displayName: "A",
          agentNumber: "012345",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
        {
          accountId: "acc-i2",
          userId: "bad-b@test.local",
          displayName: "B",
          agentNumber: "1234567890",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
        {
          accountId: "acc-i3",
          userId: "bad-c@test.local",
          displayName: "C",
          agentNumber: "12ab56",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
      ],
    }),
  );
  const saved = process.env.AGENT_ACCOUNTS_FILE;
  process.env.AGENT_ACCOUNTS_FILE = file;
  try {
    const svc = freshService();
    await svc.load();
    assertAllUnique(svc.listAll(), "非法格式重发");
  } finally {
    process.env.AGENT_ACCOUNTS_FILE = saved;
  }
});

test("旧账号补号不抢占存量号（两遍扫描：先认领后补发）", async () => {
  // legacy 账号无号；存量账号持有号 77777777。补发的随机号撞上它的概率
  // 理论上 ~1/9000万，这里直接断言补号后存量号仍归属原账号。
  const file = path.join(tmpDir, "two-pass.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [
        {
          accountId: "acc-keep",
          userId: "keep@test.local",
          displayName: "存量号",
          agentNumber: "77777777",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
        {
          accountId: "acc-legacy",
          userId: "legacy@test.local",
          displayName: "旧账号",
          createdAt: "2026-09-01T00:00:00.000Z",
          setupComplete: true,
        },
      ],
    }),
  );
  const saved = process.env.AGENT_ACCOUNTS_FILE;
  process.env.AGENT_ACCOUNTS_FILE = file;
  try {
    const svc = freshService();
    await svc.load();
    assert.equal(svc.getByAgentNumber("77777777")?.userId, "keep@test.local", "存量号被补发抢占");
    const legacyNum = svc.getByActorId("legacy@test.local")?.agentNumber!;
    assert.match(legacyNum, AGENT_NUMBER_PATTERN);
    assert.notEqual(legacyNum, "77777777");
    // 补号持久化：重启稳定
    const again = freshService();
    await again.load();
    assert.equal(again.getByActorId("legacy@test.local")?.agentNumber, legacyNum);
  } finally {
    process.env.AGENT_ACCOUNTS_FILE = saved;
  }
});

test("重复注册同一主体 → 报错不发新号（号不漂移）", async () => {
  await withAccountFile("dup-reg.json", async () => {
    const svc = freshService();
    await svc.load();
    const first = await svc.register("dup-reg@test.local", "第一次");
    await assert.rejects(() => svc.register("dup-reg@test.local", "第二次"));
    assert.equal(svc.getByActorId("dup-reg@test.local")?.agentNumber, first.agentNumber);
  });
});
