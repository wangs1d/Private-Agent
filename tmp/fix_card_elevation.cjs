const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/core/theme/app_theme.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// 三个主题的 cardTheme elevation 从 2 调到 3，阴影更明显
c = c.replace(
  '        elevation: 2,\n        shadowColor: const Color(0x40000000),',
  '        elevation: 3,\n        shadowColor: const Color(0x40000000),'
);
ok++;

c = c.replace(
  '        elevation: 2,\n        shadowColor: const Color(0x1A000000),',
  '        elevation: 3,\n        shadowColor: const Color(0x1A000000),',
);
// 替换所有出现（浅色和暖白都用 0x1A000000）
const count = (c.match(/elevation: 3,\n        shadowColor: const Color\(0x1A000000\),/g) || []).length;
console.log('light/warm card elevation count:', count);

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('card elevation updated');
