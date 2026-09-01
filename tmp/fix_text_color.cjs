const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/message_body_renderer.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// 用户消息文字色：onPrimaryContainer → onPrimary
const oldText = `  if (isUser) {
    return Text(
      message.text,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onPrimaryContainer,
          ),
    );
  }`;
const newText = `  if (isUser) {
    return Text(
      message.text,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onPrimary,
          ),
    );
  }`;
if (c.includes(oldText)) { c = c.replace(oldText, newText); ok++; console.log('user text color ok'); } else console.log('user text color MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/1');
