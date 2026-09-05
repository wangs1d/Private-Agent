# @private-ai-agent/picture

图片能力套件(本地子包),将 `E:\ws-project\picture` 的摄影 Agent 能力移植进
Private-Agent monorepo,并扩展图片生成、图像处理、图像解析、缩略图、
图片存储管理与**人像美颜批图**。

## 美颜批图(面向人像/自拍场景)

`processing/beauty.ts` 实现修图师式工作流,而非全局滤镜:

- **频率分离磨皮**:低频底色 + 衰减高频,皮肤细腻但五官/发丝/背景边缘不糊;
- **肤色掩码**:YCbCr 肤色规则 + 羽化,所有皮肤类操作只落在皮肤上;
- **皮肤修饰**:`skinBrighten` 透亮 / `whiten` 冷白皮 / `rosy` 红润气血;
- **氛围**:`vibrance` 智能鲜艳 / `clarity` 质感 / `fade` 褪色胶片感;
- **成品风格**:`natural` 自然美颜 / `creamy` 奶油肌 / `cool_white` 冷白皮 /
  `japanese` 日系清透 / `hongkong` 港风复古(`listBeautyStyles()`);

```ts
import { BatchService, SharpBatchEngine, applyBeauty } from '@private-ai-agent/picture';

// 一键风格
const batch = new BatchService(new SharpBatchEngine(), 'data/batch');
await batch.processPhotos({ photoPaths: ['a.jpg'], style: 'cool_white' });

// 细粒度参数
await applyBeauty('a.jpg', { skinSmooth: 70, whiten: 20, rosy: 12 }, 'a_beauty.webp');
```

## 模块总览

| 模块 | 来源 | 说明 |
| --- | --- | --- |
| `photography/`(gallery/presets/guidance/batch/habit/evaluation) | 移植 | 摄影图库、场景预设、拍摄指导、批图、用户习惯、照片评估,方法与工具语义与 Python 版对齐 |
| `generation/` | 新增 | 图片生成,Provider 抽象 + OpenAI 兼容实现(fetch,零额外依赖) |
| `processing/` | 新增 | 基于 sharp 的图像处理:缩放/裁剪/旋转/翻转/调整/格式转换/水印 |
| `analysis/` | 新增 | 图像解析:尺寸/格式/EXIF(纯 TS 解析器)/拍摄时间/色彩统计/自动标签 |
| `thumbnails/` | 新增 | small(256)/medium(640)/large(1280) 三档 webp 缩略图 |
| `storage/` | 新增 | 图片存储管理:SHA-256 去重、JSON 索引原子持久化、筛选查询、孤儿清理 |

## 快速开始

```ts
import { createPictureKit } from '@private-ai-agent/picture';

const kit = await createPictureKit({
  rootDir: 'data/pictures',     // assets/thumbs/index.json 存放根,默认 .picture_data
  batchOutputDir: 'data/batch', // 批图输出目录,默认 .batch_output
  generation: { model: 'gpt-image-1' }, // API Key 缺省读 OPENAI_API_KEY / OPENAI_BASE_URL
});

// 统一工具入口(11 个工具,action 分发,风格与摄影 Agent 版一致)
const result = await kit.invokeRaw('gallery', { action: 'upload', file_path: './cat.jpg' });
await kit.invokeRaw('image_generate', { prompt: '一只橘猫', size: '1024x1024' });
await kit.invokeRaw('evaluation', { action: 'evaluate', photo_path: './cat.jpg' });
```

也可以按需直接使用各 Service:

```ts
import { ImageStore, ImageProcessingService, EvaluationService } from '@private-ai-agent/picture';

const store = new ImageStore({ rootDir: 'data/pictures' });
await store.init();
const { asset, deduplicated } = await store.ingest('./cat.jpg', { tags: ['pet'] });

await new ImageProcessingService().resize('./cat.jpg', { width: 320, fit: 'cover' });
const result = await new EvaluationService().evaluate('./cat.jpg');
```

## 与 server 集成

包已加入根 `workspaces`;server 只需在依赖中加入
`"@private-ai-agent/picture": "0.1.0"` 即可 import 使用,例如在
`create-app-services` 中实例化 `createPictureKit({ rootDir: 'data/pictures' })`,
并把 11 个工具经 `registry.listTools()` 暴露给意图路由/工具循环。

## 开发

```bash
npm run check   # tsc --noEmit
npm run build   # 输出 dist/
npm test        # node --test (tsx)
```
