const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 定位加载界面结尾：Container 关闭后缺 Scaffold 的闭合
const old = `                  ],
                ),
              ),
            ),
          );
        },
      );
    }

    // 监听主题控制器`;

const fix = `                  ],
                  ),
                ),
              ),
            ),
          );
        },
      );
    }

    // 监听主题控制器`;

if (c.includes(old)) {
  c = c.replace(old, fix);
  c = c.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, c);
  console.log('bracket fixed');
} else {
  console.log('MISS - pattern not found');
}
