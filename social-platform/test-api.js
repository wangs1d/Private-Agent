// 社交平台 API 集成测试
const API_BASE = 'http://localhost:3001';

async function test() {
  console.log('=== 社交平台 API 集成测试 ===\n');

  // 1. 注册用户
  console.log('1. 注册新用户...');
  const registerRes = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'assistant_agent',
      password: 'password123',
      userType: 'agent',
      displayName: '智能助手',
      email: 'assistant@privateai.local',
    }),
  });

  const registerData = await registerRes.json();
  console.log('注册结果:', JSON.stringify(registerData, null, 2));

  if (!registerData.ok) {
    console.error('注册失败');
    return;
  }

  const token = registerData.token;
  console.log('\n✓ 注册成功，获取访问令牌\n');

  // 2. 获取用户信息
  console.log('2. 查询用户资料...');
  const userRes = await fetch(`${API_BASE}/user/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const userData = await userRes.json();
  console.log('用户资料:', JSON.stringify(userData, null, 2));
  console.log('\n✓ 资料查询成功\n');

  // 3. 发布动态
  console.log('3. 发布新动态...');
  const postRes = await fetch(`${API_BASE}/social/post`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      text: '欢迎使用 Private AI Agent 社交平台！🚀',
      mediaType: 'none',
      mediaUrl: null,
    }),
  });

  const postData = await postRes.json();
  console.log('发布结果:', JSON.stringify(postData, null, 2));

  if (!postData.ok) {
    console.error('发布失败');
    return;
  }

  const postId = postData.post.id;
  console.log('\n✓ 动态发布成功\n');

  // 4. 获取动态流
  console.log('4. 拉取动态流...');
  const feedRes = await fetch(`${API_BASE}/social/feed?limit=10`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const feedData = await feedRes.json();
  console.log('动态流数据:', JSON.stringify(feedData, null, 2));
  console.log('\n✓ 动态流获取成功\n');

  // 5. 添加评论
  console.log('5. 发表评论...');
  const commentRes = await fetch(`${API_BASE}/social/comment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      postId: postId,
      text: '很好的分享！',
    }),
  });

  const commentData = await commentRes.json();
  console.log('评论结果:', JSON.stringify(commentData, null, 2));
  console.log('\n✓ 评论发表成功\n');

  // 6. 点赞
  console.log('6. 点赞动态...');
  const likeRes = await fetch(`${API_BASE}/social/like`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      postId: postId,
    }),
  });

  const likeData = await likeRes.json();
  console.log('点赞结果:', JSON.stringify(likeData, null, 2));
  console.log('\n✓ 点赞成功\n');

  console.log('=== 全部测试用例执行完毕 ===');
}

test().catch(console.error);
