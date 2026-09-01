const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/chat_page.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// ═══════ 用户气泡：纯色 → 135° 强调色渐变 + 投影 ═══════

const oldUserDeco = `    final Decoration decoration;
    if (widget.isUser) {
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        color: cs.primaryContainer,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: cs.primary.withValues(alpha: 0.15),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      );
    } else {`;

const newUserDeco = `    final Decoration decoration;
    if (widget.isUser) {
      // 135° 强调色渐变（primary → 暗 25%），与预览器 priGrad 一致
      final Color priDark = Color.lerp(cs.primary, Colors.black, 0.25)!;
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[cs.primary, priDark],
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: cs.primary.withValues(alpha: 0.27),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
      );
    } else {`;

if (c.includes(oldUserDeco)) { c = c.replace(oldUserDeco, newUserDeco); ok++; console.log('user bubble deco ok'); } else console.log('user bubble deco MISS');

// ═══════ 用户气泡文字色：onPrimaryContainer → onPrimary ═══════
// 配图文字
const oldAttachText = `                      Icon(
                        Icons.photo_camera_outlined,
                        size: 14,
                        color: widget.isUser
                            ? Theme.of(context).colorScheme.onPrimaryContainer
                            : Theme.of(context).colorScheme.primary,
                      ),`;
const newAttachText = `                      Icon(
                        Icons.photo_camera_outlined,
                        size: 14,
                        color: widget.isUser
                            ? Theme.of(context).colorScheme.onPrimary
                            : Theme.of(context).colorScheme.primary,
                      ),`;
if (c.includes(oldAttachText)) { c = c.replace(oldAttachText, newAttachText); ok++; console.log('attach icon ok'); } else console.log('attach icon MISS');

const oldAttachLabel = `                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: widget.isUser
                                  ? Theme.of(context)
                                      .colorScheme
                                      .onPrimaryContainer
                                  : Theme.of(context).colorScheme.primary,
                            ),`;
const newAttachLabel = `                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: widget.isUser
                                  ? Theme.of(context)
                                      .colorScheme
                                      .onPrimary
                                  : Theme.of(context).colorScheme.primary,
                            ),`;
if (c.includes(oldAttachLabel)) { c = c.replace(oldAttachLabel, newAttachLabel); ok++; console.log('attach label ok'); } else console.log('attach label MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total ok:', ok, '/3');
