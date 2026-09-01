const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

const oldLoading = `            home: Scaffold(
              backgroundColor: AppPalette.resolveMainPanel(variant),
              body: Center(
                child: Column(`;

const newLoading = `            home: Scaffold(
              backgroundColor: Colors.transparent,
              body: Container(
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
                child: Center(
                  child: Column(`;

if (c.includes(oldLoading)) { c = c.replace(oldLoading, newLoading); ok++; console.log('loading scaffold ok'); } else console.log('loading scaffold MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/1');
