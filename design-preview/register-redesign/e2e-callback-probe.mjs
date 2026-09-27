// 模拟桌面端的回环监听：收到 /callback?state=..&email=.. 即打印并退出
import { createServer } from "node:http";
const state = "e2e" + Date.now().toString(36);
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/callback") { res.statusCode = 404; res.end(); return; }
  console.log("CALLBACK_OK state=" + url.searchParams.get("state") + " email=" + url.searchParams.get("email"));
  console.log("STATE_MATCH=" + (url.searchParams.get("state") === state));
  res.end("<html><body>ok</body></html>");
  setTimeout(() => { server.close(); process.exit(0); }, 300);
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("AUTH_URL=http://127.0.0.1:3000/accounts/web?cb=" + encodeURIComponent("http://127.0.0.1:" + port + "/callback") + "&state=" + state);
});
setTimeout(() => { console.log("TIMEOUT_NO_CALLBACK"); process.exit(1); }, 120000);
