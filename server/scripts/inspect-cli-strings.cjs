const fs = require("fs");
const p = "server/alipay-bot-cli/runtime/dist/cli.js";
if (!fs.existsSync(p)) { console.log("NOT FOUND", p); process.exit(0); }
const s = fs.readFileSync(p, "utf8");
console.log("bytes:", s.length);
for (const n of ["proxy-trade-request", "proxy_trade", "extract-path", "extractPath", "payloadType", "payload-type", "submit-payment"]) {
  const i = s.indexOf(n);
  console.log("=== ", n, " first idx:", i);
  if (i !== -1) {
    console.log(s.slice(Math.max(0, i - 200), i + 200).replace(/\n/g, "\\n"));
  }
}
