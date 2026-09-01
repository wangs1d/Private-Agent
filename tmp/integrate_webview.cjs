const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// 1. 添加导入
const oldImport = 'import "features/chat/chat_page.dart";\nimport "features/chat/chat_layout.dart";';
const newImport = 'import "features/chat/chat_page.dart";\nimport "features/chat/chat_webview_page.dart";\nimport "features/chat/chat_layout.dart";';
if (c.includes(oldImport)) { c = c.replace(oldImport, newImport); ok++; console.log('import ok'); } else console.log('import MISS');

// 2. 在 _buildChatPage 中把 ChatPage( 改成 ChatWebViewPage(
const oldBuild = '  Widget _buildChatPage(BuildContext context) {\n    return ChatPage(';
const newBuild = '  Widget _buildChatPage(BuildContext context) {\n    // 试点：聊天主界面用 WebView 承载 Vue3 UI，业务逻辑保留 Dart 侧\n    return ChatWebViewPage(';
if (c.includes(oldBuild)) { c = c.replace(oldBuild, newBuild); ok++; console.log('build ok'); } else console.log('build MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/2');
