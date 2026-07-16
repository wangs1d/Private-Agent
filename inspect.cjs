const fs = require("fs");
const path = "E:\\ws-project\\Private-Agent\\server\\src\\tools\\agent-capability-query-tools.ts";
const content = fs.readFileSync(path, "utf8");
console.log("First 3 bytes:", content.charCodeAt(0), content.charCodeAt(1), content.charCodeAt(2));
console.log("Total length:", content.length);
const lines = content.split("\n");
console.log("Total lines:", lines.length);
for (const idx of [54, 55, 56, 57, 58, 59]) {
  const line = lines[idx];
  if (line === undefined) { console.log(`Line ${idx}: undefined`); continue; }
  console.log(`Line ${idx}: length=${line.length} content=`, JSON.stringify(line));
}
