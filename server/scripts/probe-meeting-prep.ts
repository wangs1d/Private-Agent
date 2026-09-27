/**
 * 会前准备包断点探针：沙箱启动真实装配 → 创建 +30min 日程 → 每 30s 采样
 * goalStats / schedule 传感器健康 / goals.json 是否落盘，定位 prep 未创建的原因。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pa-probe-prep-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);
process.env.PROACTIVITY_QUIET_START = "0";
process.env.PROACTIVITY_QUIET_END = "0";
const log = (s: string): void => console.log(`[probe-prep] ${s}`);

const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: 3101, host: "127.0.0.1" });
log("服务端已监听 3101");

const runAt = new Date(Date.now() + 30 * 60_000).toISOString();
const res = await fetch("http://127.0.0.1:3101/schedule/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionId: "local_user",
    title: "prep 探针会",
    description: "x",
    kind: "reminder",
    recurrence: "none",
    runAt,
    reminderMessage: "x",
  }),
});
log(`任务创建: ${JSON.stringify((await res.json()).ok)}`);

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 30_000));
  const diag = (await (await fetch("http://127.0.0.1:3101/api/proactivity/sensors")).json()) as {
    sensors?: Array<Record<string, unknown>>;
    goals?: { total?: number; preparing?: number; ready?: number };
  };
  const stats = diag.goals ?? {};
  const health = (diag.sensors ?? []).find((h) => h.sensorId === "schedule_upcoming");
  const goalsFile = join(sandbox, "data", "proactivity", "goals.json");
  const goalFileState = existsSync(goalsFile) ? readFileSync(goalsFile, "utf8").slice(0, 200) : "(不存在)";
  log(
    `t+${((i + 1) * 30) / 60}min goalStats=${JSON.stringify(stats)} scheduleSensor=${JSON.stringify({
      emitted: health?.emitted,
      lastOkAt: health?.lastOkAt ? "有" : "无",
      tripped: health?.tripped,
    })} goals.json=${goalFileState}`,
  );
  if (stats.total > 0) break;
}
try {
  await services.app.close();
} catch {
  /* ignore */
}
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  log(`沙箱保留: ${sandbox}`);
}
process.exit(0);
