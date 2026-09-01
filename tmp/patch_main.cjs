const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/main.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

// 1) chat tab(_tabIndex==0) 时隐藏外层 Flutter AppBar，由 WebView 内 Vue 标题栏接管；
//    其他 tab 保留原生 AppBar。
const oldAppBar = `                                Padding(
                                  padding: EdgeInsets.only(
                                    right: _appBarRightInset(),
                                  ),
                                  child: AppBar(`;
const newAppBar = `                                // chat 主界面标题栏已迁移到 WebView(Vue ChatHeader)，
                                // chat tab 隐藏原生 AppBar；其他页面保留 Flutter AppBar。
                                if (_tabIndex != 0)
                                  Padding(
                                  padding: EdgeInsets.only(
                                    right: _appBarRightInset(),
                                  ),
                                  child: AppBar(`;
if (c.includes(oldAppBar)) { c = c.replace(oldAppBar, newAppBar); ok++; console.log('appbar conditional ok'); }
else console.log('appbar MISS');

// 2) _buildChatPage 补 onClearAllChat 回调
const oldCall = `      onStopAgent: _cancelCurrentTurn,
      onUserAction: _handleCardAction,
    );`;
const newCall = `      onStopAgent: _cancelCurrentTurn,
      onUserAction: _handleCardAction,
      onClearAllChat: _confirmClearAllChat,
    );`;
if (c.includes(oldCall)) { c = c.replace(oldCall, newCall); ok++; console.log('clearAll callback ok'); }
else console.log('clearAll MISS');

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('total', ok, '/2');
