const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

const oldDivider = `                        VerticalDivider(
                          width: 1,
                          thickness: 1,
                          color: AppPalette.resolveSidebarSeparator(variant),
                        ),`;

const newDivider = `                        VerticalDivider(
                          width: 1,
                          thickness: 1,
                          // 纸白浅色靠侧栏右侧投影分隔，不需要分隔线
                          color: variant == AppThemeVariant.light
                              ? Colors.transparent
                              : AppPalette.resolveSidebarSeparator(variant),
                        ),`;

if (c.includes(oldDivider)) { c = c.replace(oldDivider, newDivider); ok++; console.log('divider ok'); } else console.log('divider MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/1');
