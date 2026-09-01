const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/widgets/app_sidebar.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

const oldSidebar = `    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebar(variant);

    return Container(
      width: _sidebarWidth,
      decoration: BoxDecoration(color: bgColor),
      clipBehavior: Clip.hardEdge,
      child: Material(
        color: bgColor,`;

const newSidebar = `    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebar(variant);
    final Color mpColor = AppPalette.resolveMainPanel(variant);
    final bool isDark = variant == AppThemeVariant.dark;
    final bool isPaper = variant == AppThemeVariant.light;

    // 侧栏背景：纸白浅色纯白+右侧投影，暖白浅色纵向渐变，暗色纯色
    final BoxDecoration sidebarDeco = BoxDecoration(
      color: isDark || isPaper ? bgColor : null,
      gradient: !isDark && !isPaper
          ? LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                bgColor,
                Color.lerp(bgColor, mpColor, 0.3)!,
              ],
            )
          : null,
      boxShadow: isPaper
          ? const <BoxShadow>[
              BoxShadow(
                color: Color(0x0F000000),
                blurRadius: 32,
                offset: Offset(8, 0),
              ),
            ]
          : null,
    );

    return Container(
      width: _sidebarWidth,
      decoration: sidebarDeco,
      clipBehavior: Clip.hardEdge,
      child: Material(
        color: Colors.transparent,`;

if (c.includes(oldSidebar)) { c = c.replace(oldSidebar, newSidebar); ok++; console.log('sidebar bg ok'); } else console.log('sidebar bg MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/1');
