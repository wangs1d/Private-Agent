import { readFileSync, writeFileSync } from 'node:fs';
const env = readFileSync('server/.env', 'utf8');
const key = env.match(/SILICONFLOW_API_KEY=(\S+)/)[1];
const prompts = {
  'bg-a-window-light': '黑白电影感摄影，清晨窗光斜洒进安静的房间，照亮亚麻桌布与一只陶瓷杯的剪影，空气中悬浮尘埃的光束，胶片颗粒质感，极简构图大面积留白，安静氛围，无人物，无文字',
  'bg-b-blind-shadow': '百叶窗的光影投在浅灰色墙面上，光条与阴影的几何分割，黑白摄影，胶片质感，极简抽象构图，安静的电影氛围，无人物，无文字',
  'bg-c-fabric-side-light': '深灰黑色背景，一束柔和侧光照亮丝绸织物的褶皱，明暗过渡细腻，电影感布光，低饱和近黑白，质感细节丰富，极简，无人物，无文字',
};
for (const [name, prompt] of Object.entries(prompts)) {
  const res = await fetch('https://api.siliconflow.cn/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Kwai-Kolors/Kolors', prompt, image_size: '768x1024', batch_size: 1 }),
  });
  const data = await res.json();
  if (!data.images?.[0]?.url) { console.error(name, 'FAIL', JSON.stringify(data).slice(0, 300)); continue; }
  const img = await fetch(data.images[0].url);
  writeFileSync(`design-preview/register-redesign/${name}.png`, Buffer.from(await img.arrayBuffer()));
  console.log(name, 'OK');
}
