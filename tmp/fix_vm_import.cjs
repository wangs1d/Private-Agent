const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/chat_message_view_model.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
c = c.replace(
  'import "chat_models.dart" show ChatMessage, MessageAttachment, MessageAttachmentType;',
  'import "../../core/models/chat_models.dart" show ChatMessage, MessageAttachment, MessageAttachmentType;'
);
c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('import fixed:', c.includes('../../core/models/chat_models.dart'));
