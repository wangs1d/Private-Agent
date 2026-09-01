const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const old = 'import "features/chat/chat_page.dart";';
const fix = '// ignore: unused_import  保留原生 ChatPage，便于 WebView 试点回退\nimport "features/chat/chat_page.dart";';
if (c.includes(old)) {
  c = c.replace(old, fix);
  c = c.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, c);
  console.log('ignore added');
} else console.log('MISS');
