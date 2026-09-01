const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/chat_webview/src/App.vue';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const old = `  // Agent 名称
  on('agentInfo', (data) => {
    if (data.agentName) agentName.value = data.agentName
  })
})`;

const mock = `  // Agent 名称
  on('agentInfo', (data) => {
    if (data.agentName) agentName.value = data.agentName
  })

  // ─── 开发模式 mock（普通浏览器中无 Dart 桥接时注入演示数据）───
  if (!window.chrome?.webview) {
    const order = ['light', 'warm', 'dark']
    let idx = 0
    themeKey.value = 'light'
    window.addEventListener('keydown', (e) => {
      if (e.key === 't' || e.key === 'T') {
        idx = (idx + 1) % order.length
        themeKey.value = order[idx]
        console.log('[dev] theme =', themeKey.value)
      }
    })
    messages.value = [
      { messageId: 'm1', role: 'user', isUser: true, text: '帮我查一下今天的天气', timestamp: Date.now() - 60000 },
      { messageId: 'm2', role: 'assistant', isUser: false, text: '好的，我正在为你查询当地天气信息，请稍等。', timestamp: Date.now() - 55000 },
      { messageId: 'm3', role: 'user', isUser: true, text: '顺便帮我规划一下周末的行程安排', timestamp: Date.now() - 40000 },
      { messageId: 'm4', role: 'assistant', isUser: false, text: '没问题。根据天气情况，周六上午适合户外活动，下午可能有阵雨，建议安排室内项目。我先帮你看看周边有哪些值得去的地方。', timestamp: Date.now() - 35000 },
    ]
    isProcessing.value = true
    statusLine.value = '正在搜索周边景点信息'
    statusPercent.value = 60
    scrollToBottom()
    console.log('[dev] mock loaded, press T to toggle theme')
  }
})`;

if (c.includes(old)) {
  c = c.replace(old, mock);
  c = c.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, c);
  console.log('mock added');
} else {
  console.log('MISS');
}
