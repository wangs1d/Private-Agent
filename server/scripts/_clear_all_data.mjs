// 一次性脚本：清空聊天记录与 Agent 全部记忆（直接改写 data 目录下的 JSON 存储）。
// 运行后即可删除本文件。
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

const dataDir = process.cwd();

const files = {
  "chat-threads.json": (o) => {
    o.sessions = {};
  },
  "chat-threads-notes.json": (o) => {
    o.sessions = {};
  },
  "agent-memory-sync.json": (o) => {
    o.sessions = {};
  },
  "human-memory.json": (o) => {
    // 保留政策 domains 配置，仅清空记忆本体(节点/边/版本/社区)
    o.nodes = {};
    o.edges = {};
    o.versions = {};
    o.communities = {};
  },
  "daily-digests.json": (o) => {
    // 当日摘要(每轮无条件注入 source=digest，串台头号来源)
    o.digests = {};
  },
  "short-term-task-stack.json": (o) => {
    // 短期任务栈 + 情景记忆(conversationMemory/currentMission 会注入 prompt)
    o.sessions = {};
    if (o.episodic) o.episodic = {};
  },
  "interest-watch.json": (o) => {
    // 用户兴趣关注列表(注入【用户兴趣关注列表】块)
    if (o.interests) o.interests = {};
    if (o.records) o.records = {};
  },
};

// 行式日志文件整体置空
const blankFiles = ["agent-learning-log.jsonl"];

for (const [name, mutate] of Object.entries(files)) {
  const path = `${dataDir}/data/${name}`;
  let exists = true;
  try {
    await access(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    console.log(`[skip] ${name} 不存在`);
    continue;
  }
  const raw = await readFile(path, "utf8");
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error(`[error] ${name} 解析失败: ${e.message}`);
    continue;
  }
  mutate(obj);
  await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  console.log(`[ok] ${name} 已清空`);
}

for (const name of blankFiles) {
  const path = `${dataDir}/data/${name}`;
  let exists = true;
  try {
    await access(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    console.log(`[skip] ${name} 不存在`);
    continue;
  }
  await writeFile(path, "", "utf8");
  console.log(`[ok] ${name} 已置空`);
}

console.log("完成：聊天记录与 Agent 记忆已清空");