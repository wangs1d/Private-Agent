process.env.PA_DATA_DIR = "tmp-probe-golden5";
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.ts"
);
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.ts"
);

const all = getBuiltinAgentChatTools();
const withoutNew = all.filter(
  (t) =>
    !(t.type === "function" &&
      ["calendar.update_task", "calendar.find_free_slots"].includes(t.function?.name)),
);

for (const [label, tools] of [
  ["with-new-tools", all],
  ["baseline(no new)", withoutNew],
]) {
  const prepared = prepareToolsWithToolSearch([], tools);
  const res = await executeToolSearchBridge(
    "tool_discover",
    { query: "明天早上九点提醒我开会", limit: 8 },
    prepared.deferredCatalog,
  );
  console.log(
    `== ${label} ==\n` +
      res.result.matches.map((m, i) => `${i + 1} ${m.name} ${m.score}`).join("\n"),
  );
}
