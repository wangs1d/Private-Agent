const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/chat_webview_page.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const old = 'import "../../core/models/turn_state.dart";';
const add = 'import "../../core/models/turn_state.dart";\nimport "../../core/utils/agent_result_parser.dart";\nimport "agent_profile_page.dart";';
if (c.includes(old)) {
  c = c.replace(old, add);
  c = c.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, c);
  console.log('imports added');
} else {
  console.log('MISS');
}
