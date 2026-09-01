const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// ═══════ 主界面 Scaffold：透明背景 + 渐变层 ═══════
const oldScaffold = `              return Scaffold(
                body: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    Row(`;

const newScaffold = `              return Scaffold(
                backgroundColor: Colors.transparent,
                body: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    // 背景渐变：浅色下顶部更亮（主背景混 40% 白），渐变到主背景；暗色纯色
                    Positioned.fill(
                      child: Container(
                        decoration: BoxDecoration(
                          color: variant == AppThemeVariant.dark
                              ? AppPalette.resolveMainPanel(variant)
                              : null,
                          gradient: variant == AppThemeVariant.dark
                              ? null
                              : LinearGradient(
                                  begin: Alignment.topCenter,
                                  end: Alignment.bottomCenter,
                                  colors: <Color>[
                                    Color.lerp(
                                      AppPalette.resolveMainPanel(variant),
                                      Colors.white,
                                      0.4,
                                    )!,
                                    AppPalette.resolveMainPanel(variant),
                                  ],
                                ),
                        ),
                      ),
                    ),
                    Row(`;

if (c.includes(oldScaffold)) { c = c.replace(oldScaffold, newScaffold); ok++; console.log('main scaffold ok'); } else console.log('main scaffold MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/1');
