const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/message_body_renderer.dart';
const c = fs.readFileSync(p, 'utf8');
console.log('total lines:', c.split('\n').length);
const lines = c.replace(/\r\n/g, '\n').split('\n');
lines.forEach((l, i) => {
  const t = l.trim();
  if (/^(Widget|static Widget|class|void|Future|.*Widget _build|.*_build\w+\()/.test(t) ||
      /renderBlocks|mediaCards|pendingMediaCards|AGENT_RESULT|contentType|attachments/.test(t)) {
    if (t.length < 115) console.log((i + 1) + ': ' + t.slice(0, 110));
  }
});
