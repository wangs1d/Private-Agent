// 测试 WebSocket 连接
const WebSocket = require('ws');

const WS_URL = 'ws://localhost:3001/ws';

async function testWebSocket() {
  console.log('=== 测试 WebSocket ===\n');

  // 先注册获取 token
  const registerRes = await fetch('http://localhost:3001/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `ws_user_${Date.now()}`,
      password: 'password123',
      userType: 'human',
      displayName: 'WS Test User',
    }),
  });

  const registerData = await registerRes.json();
  if (!registerData.ok) {
    console.error('注册失败');
    return;
  }

  const token = registerData.token;
  console.log('✓ 已获取令牌\n');

  // 连接 WebSocket
  console.log('正在连接 WebSocket...');
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✓ WebSocket 连接成功\n');

    // 初始化会话
    console.log('1. 初始化会话...');
    ws.send(JSON.stringify({
      type: 'session.init',
      payload: { token },
    }));
  });

  let hasLiked = false;

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log('收到消息:', message.type);
    
    if (message.type === 'session.ready') {
      console.log('   会话就绪:', message.payload);
      console.log('\n2. 发布推文...');
      
      // 发布推文
      ws.send(JSON.stringify({
        type: 'social.post',
        payload: {
          text: 'Hello via WebSocket! 🎉',
          mediaType: 'none',
          mediaUrl: null,
        },
      }));
    } else if (message.type === 'social.feed_snapshot') {
      console.log('   收到动态流更新，帖子数:', message.payload.posts?.length || 0);
      
      if (message.payload.posts && message.payload.posts.length > 0 && !hasLiked) {
        const latestPost = message.payload.posts[0];
        console.log('   最新帖子:', latestPost.text);
        
        console.log('\n3. 点赞...');
        hasLiked = true;
        ws.send(JSON.stringify({
          type: 'social.like_toggle',
          payload: { postId: latestPost.id },
        }));
      }
    } else if (message.type === 'error') {
      console.error('   错误:', message.payload);
    } else {
      console.log('   数据:', JSON.stringify(message.payload, null, 2).slice(0, 200));
    }
  });

  ws.on('close', () => {
    console.log('\nWebSocket 连接关闭');
  });

  ws.on('error', (error) => {
    console.error('WebSocket 错误:', error);
  });

  // 10秒后关闭
  setTimeout(() => {
    console.log('\n测试完成，关闭连接...');
    ws.close();
    process.exit(0);
  }, 10000);
}

testWebSocket().catch(console.error);
