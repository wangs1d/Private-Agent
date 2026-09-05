/**
 * Agent 工具注册:移植 picture 项目的 gallery/presets/guidance/batch/habit/
 * evaluation 六组工具,并新增 image_generate / image_process / image_analyze /
 * thumbnail / image_store 五个图像能力工具。
 * 每组整合为单个工具,通过 arguments.action 分发。
 */
import { requireArg, optionalArg, makeSchema } from './registry.js';
import type { AgentInterface, ToolDefinition } from './registry.js';
import type { ImageGenerationRequest, ImageProvider } from './generation/service.js';
import { ImageGenerationService, OpenAIImageProvider } from './generation/service.js';
import type { ImageAdjustments } from './processing/service.js';
import { listBeautyStyles } from './processing/batch.js';
import type { PictureKit } from './kit.js';

function str(value: unknown): string {
  return String(value);
}

function num(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`参数应为数字: ${String(value)}`);
  }
  return parsed;
}

function maybeNum(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : num(value);
}

export interface ToolRegistrationContext {
  kit: PictureKit;
  generation: ImageGenerationService;
  generatedDir: string;
}

export function registerGenerationProvider(provider: ImageProvider, context: ToolRegistrationContext, isDefault = false): void {
  context.generation.registerProvider(provider, isDefault);
}

export function registerPictureTools(iface: AgentInterface, context: ToolRegistrationContext): void {
  const { kit, generation, generatedDir } = context;

  // ------------------------------------------------------------------
  // gallery 图库控制(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'gallery',
      description: [
        '图库管理工具,通过 action 字段指定操作。支持:',
        'upload(file_path, auto_tag?) / upload_batch(file_paths, auto_tag?) /',
        'query(filters?{tags,scene_type,rating_min,rating_max,time_from,time_to,lens_focal_length,format}, page?, page_size?, sort_by?, sort_order?) /',
        'get(photo_id) / add_tag(photo_id, tag) / remove_tag(photo_id, tag) /',
        'set_scene(photo_id, scene_type) / set_rating(photo_id, rating 0-100)',
      ].join(' '),
      inputSchema: makeSchema({
        action: { type: 'string', enum: ['upload', 'upload_batch', 'query', 'get', 'add_tag', 'remove_tag', 'set_scene', 'set_rating'] },
        file_path: { type: 'string' },
        file_paths: { type: 'array', items: { type: 'string' } },
        auto_tag: { type: 'boolean' },
        filters: { type: 'object' },
        page: { type: 'integer' },
        page_size: { type: 'integer' },
        sort_by: { type: 'string', enum: ['created_at', 'rating', 'file_name', 'file_size'] },
        sort_order: { type: 'string', enum: ['asc', 'desc'] },
        photo_id: { type: 'string' },
        tag: { type: 'string' },
        scene_type: { type: 'string' },
        rating: { type: 'integer' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const gallery = kit.gallery;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'upload': {
          const asset = await gallery.uploadPhoto(str(requireArg(args, 'file_path')), {
            autoTag: optionalArg(args, 'auto_tag', true),
          });
          return { photo: asset };
        }
        case 'upload_batch': {
          const filePaths = requireArg<string[]>(args, 'file_paths');
          const photos = await gallery.uploadPhotos(filePaths, {
            autoTag: optionalArg(args, 'auto_tag', true),
          });
          return { photos, count: photos.length };
        }
        case 'query': {
          const filters = optionalArg<Record<string, unknown>>(args, 'filters', {});
          return await gallery.queryPhotos({
            filters: {
              tags: filters['tags'] as string[] | undefined,
              sceneType: filters['scene_type'] as string | undefined,
              ratingMin: filters['rating_min'] as number | undefined,
              ratingMax: filters['rating_max'] as number | undefined,
              timeFrom: filters['time_from'] as string | undefined,
              timeTo: filters['time_to'] as string | undefined,
              lensFocalLength: filters['lens_focal_length'] as number | undefined,
              format: filters['format'] as string | undefined,
            },
            page: optionalArg(args, 'page', 1),
            pageSize: optionalArg(args, 'page_size', 20),
            sortBy: optionalArg(args, 'sort_by', 'created_at'),
            sortOrder: optionalArg(args, 'sort_order', 'desc'),
          });
        }
        case 'get': {
          const photo = gallery.getPhoto(str(requireArg(args, 'photo_id')));
          if (!photo) {
            throw new Error(`照片不存在: ${str(args['photo_id'])}`);
          }
          return { photo };
        }
        case 'add_tag':
          return { photo: await gallery.addTag(str(requireArg(args, 'photo_id')), str(requireArg(args, 'tag'))) };
        case 'remove_tag':
          return { photo: await gallery.removeTag(str(requireArg(args, 'photo_id')), str(requireArg(args, 'tag'))) };
        case 'set_scene':
          return { photo: await gallery.setSceneType(str(requireArg(args, 'photo_id')), str(requireArg(args, 'scene_type'))) };
        case 'set_rating':
          return { photo: await gallery.setRating(str(requireArg(args, 'photo_id')), num(requireArg(args, 'rating'))) };
        default:
          throw new Error(`未知的 gallery action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // presets 场景预设(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'presets',
      description: '场景预设工具。action: get/list/save/delete/apply',
      inputSchema: makeSchema({
        action: { type: 'string', enum: ['get', 'list', 'save', 'delete', 'apply'] },
        preset_id: { type: 'string' },
        scene_type: { type: 'string' },
        builtin_only: { type: 'boolean' },
        custom_only: { type: 'boolean' },
        name: { type: 'string' },
        lens: { type: 'object' },
        composition: { type: 'object' },
        pose: { type: 'object' },
        batch_style: { type: 'object' },
        tags: { type: 'array', items: { type: 'string' } },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    (args) => {
      const presets = kit.presets;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'get':
          return { preset: presets.getPreset(str(requireArg(args, 'preset_id'))) };
        case 'list':
          return {
            presets: presets.listPresets({
              sceneType: args['scene_type'] as string | undefined,
              builtinOnly: optionalArg(args, 'builtin_only', false),
              customOnly: optionalArg(args, 'custom_only', false),
            }),
          };
        case 'save': {
          const lens = requireArg<Record<string, number>>(args, 'lens');
          const composition = requireArg<Record<string, string>>(args, 'composition');
          const preset = presets.savePreset(
            str(requireArg(args, 'name')),
            str(requireArg(args, 'scene_type')),
            {
              focalLength: num(lens['focal_length'] ?? lens['focalLength'] ?? 50),
              aperture: num(lens['aperture'] ?? 2.8),
              shootingDistance: num(lens['shooting_distance'] ?? lens['shootingDistance'] ?? 3),
            },
            {
              rule: str(composition['rule'] ?? 'thirds'),
              overlayDescription: str(composition['overlay_description'] ?? composition['overlayDescription'] ?? ''),
              textAdvice: str(composition['text_advice'] ?? composition['textAdvice'] ?? ''),
            },
            (args['pose'] as never) ?? null,
            optionalArg<Record<string, number | string>>(args, 'batch_style', {}),
            optionalArg<string[]>(args, 'tags', []),
          );
          return { preset };
        }
        case 'delete':
          return { deleted: presets.deletePreset(str(requireArg(args, 'preset_id'))) };
        case 'apply':
          return { preset: presets.applyPreset(str(requireArg(args, 'preset_id'))) };
        default:
          throw new Error(`未知的 presets action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // guidance 指导拍照(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'guidance',
      description: '指导拍照工具。action: lens/shooting_target→镜头建议; scene/scene_type→场景叠加; composition/rule→构图指引; pose/pose_name→动作指引; list_poses→动作列表; deviation_check(current, target)→取景偏差; real_time_feedback(current, target)→实时提示; full(shooting_target, scene_type?, composition_rule?, pose_name?)→一站式',
      inputSchema: makeSchema({
        action: { type: 'string', enum: ['lens', 'scene', 'composition', 'pose', 'list_poses', 'deviation_check', 'real_time_feedback', 'full'] },
        shooting_target: { type: 'string' },
        scene_type: { type: 'string' },
        rule: { type: 'string' },
        pose_name: { type: 'string' },
        current_params: { type: 'object' },
        target_params: { type: 'object' },
        composition_rule: { type: 'string' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    (args) => {
      const guidance = kit.guidance;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'lens':
          return { lens: guidance.guideLens(str(requireArg(args, 'shooting_target'))) };
        case 'scene':
          return { overlay: guidance.guideSceneSelection(str(requireArg(args, 'scene_type'))) };
        case 'composition':
          return { composition: guidance.guideComposition(str(optionalArg(args, 'rule', 'thirds'))) };
        case 'pose':
          return { pose: guidance.guidePose(str(requireArg(args, 'pose_name'))) };
        case 'list_poses':
          return { poses: guidance.listPoses() };
        case 'deviation_check':
          return guidance.checkDeviation(
            requireArg(args, 'current_params'),
            requireArg(args, 'target_params'),
          );
        case 'real_time_feedback':
          return { hints: guidance.realTimeFeedback(requireArg(args, 'current_params'), requireArg(args, 'target_params')) };
        case 'full':
          return { guidance: guidance.fullGuidance({
            shootingTarget: str(requireArg(args, 'shooting_target')),
            sceneType: args['scene_type'] as string | undefined,
            compositionRule: args['composition_rule'] as string | undefined,
            poseName: args['pose_name'] as string | undefined,
          }) };
        default:
          throw new Error(`未知的 guidance action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // batch 批图(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'batch',
      description: '批图工具(支持人像美颜)。action: process(photo_paths, scene_type?, style?, adjustments?, user_habit?) / process_single(photo_path, adjustments) / match_preset(scene_type?, user_habit?) / list_beauty_styles→美颜风格列表 / compare(original, processed) / process_and_compare(photo_path, adjustments) / fine_tune(photo_path, base, overrides) / reapply_preset(photo_path, preset_id, overrides?) / create_preset / update_preset / delete_preset / get_preset / list_presets。美颜风格 style: natural自然/creamy奶油肌/cool_white冷白皮/japanese日系清透/hongkong港风;美颜参数: skinSmooth磨皮/skinBrighten透亮/whiten白皙/rosy红润/vibrance/clarity/fade(0-100)',
      inputSchema: makeSchema({
        action: { type: 'string' },
        photo_paths: { type: 'array', items: { type: 'string' } },
        photo_path: { type: 'string' },
        scene_type: { type: 'string' },
        style: { type: 'string', enum: ['natural', 'creamy', 'cool_white', 'japanese', 'hongkong'] },
        adjustments: { type: 'object' },
        user_habit: { type: 'object' },
        base_adjustments: { type: 'object' },
        overrides: { type: 'object' },
        preset_id: { type: 'string' },
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        original_path: { type: 'string' },
        processed_path: { type: 'string' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const batch = kit.batch;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'process':
          return await batch.processPhotos({
            photoPaths: requireArg<string[]>(args, 'photo_paths'),
            sceneType: args['scene_type'] as string | undefined,
            style: args['style'] as string | undefined,
            adjustments: args['adjustments'] as Record<string, number> | undefined,
            userHabit: args['user_habit'] as { batchStyleAvg?: Record<string, number> } | undefined,
          });
        case 'list_beauty_styles':
          return { styles: listBeautyStyles() };
        case 'process_single':
          return { output_path: await batch.processSingle(str(requireArg(args, 'photo_path')), requireArg(args, 'adjustments')) };
        case 'match_preset':
          return { preset: batch.matchPreset(args['scene_type'] as string | undefined, args['user_habit'] as { batchStyleAvg?: Record<string, number> } | undefined) };
        case 'compare':
          return await batch.compareBeforeAfter(str(requireArg(args, 'original_path')), str(requireArg(args, 'processed_path')));
        case 'process_and_compare':
          return await batch.processAndCompare(str(requireArg(args, 'photo_path')), requireArg(args, 'adjustments'));
        case 'fine_tune':
          return { output_path: await batch.fineTune(str(requireArg(args, 'photo_path')), requireArg(args, 'base_adjustments'), requireArg(args, 'overrides')) };
        case 'reapply_preset':
          return { output_path: await batch.reapplyPreset(str(requireArg(args, 'photo_path')), str(requireArg(args, 'preset_id')), args['overrides'] as Record<string, number> | undefined) };
        case 'create_preset':
          return { preset: batch.createBatchPreset(str(requireArg(args, 'name')), str(requireArg(args, 'scene_type')), requireArg(args, 'adjustments'), optionalArg<string[]>(args, 'tags', [])) };
        case 'update_preset':
          return { preset: batch.updateBatchPreset(str(requireArg(args, 'preset_id')), {
            name: args['name'] as string | undefined,
            adjustments: args['adjustments'] as Record<string, number> | undefined,
            tags: args['tags'] as string[] | undefined,
          }) };
        case 'delete_preset':
          return { deleted: batch.deleteBatchPreset(str(requireArg(args, 'preset_id'))) };
        case 'get_preset':
          return { preset: batch.getBatchPreset(str(requireArg(args, 'preset_id'))) };
        case 'list_presets':
          return { presets: batch.listBatchPresets(args['scene_type'] as string | undefined) };
        default:
          throw new Error(`未知的 batch action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // habit 用户习惯(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'habit',
      description: '用户习惯工具。action: record_shooting / learn_shooting / record_batch_adjustment / learn_batch_style / update_habit_batch_style / get_habit / recommend',
      inputSchema: makeSchema({
        action: { type: 'string' },
        user_id: { type: 'string' },
        focal_length: { type: 'integer' },
        composition_rule: { type: 'string' },
        scene_type: { type: 'string' },
        preset_adjustments: { type: 'object' },
        manual_adjustments: { type: 'object' },
        context: { type: 'object' },
      }, ['action', 'user_id']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    (args) => {
      const habit = kit.habit;
      const action = str(requireArg(args, 'action'));
      const userId = str(requireArg(args, 'user_id'));
      switch (action) {
        case 'record_shooting':
          return habit.recordShooting(userId, num(requireArg(args, 'focal_length')), str(requireArg(args, 'composition_rule')), str(requireArg(args, 'scene_type')));
        case 'learn_shooting':
          return { habit: habit.learnShootingPreference(userId) };
        case 'record_batch_adjustment':
          return habit.recordBatchAdjustment(userId, requireArg(args, 'preset_adjustments'), requireArg(args, 'manual_adjustments'));
        case 'learn_batch_style':
          return habit.learnBatchStyle(userId);
        case 'update_habit_batch_style':
          return { habit: habit.updateHabitBatchStyle(userId) };
        case 'get_habit':
          return { habit: habit.getHabit(userId) };
        case 'recommend':
          return habit.recommend(userId, optionalArg(args, 'context', {}));
        default:
          throw new Error(`未知的 habit action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // evaluation 照片评估(移植)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'evaluation',
      description: '照片评估工具。action: evaluate(photo_path, photo_id?) / evaluate_batch(photo_paths) / live_feedback(frame_path, target_params?) / set_camera_file(file_path)→注入文件帧源 / capture_and_evaluate() / capture_and_feedback(target_params?)',
      inputSchema: makeSchema({
        action: { type: 'string' },
        photo_path: { type: 'string' },
        photo_id: { type: 'string' },
        photo_paths: { type: 'array', items: { type: 'string' } },
        frame_path: { type: 'string' },
        target_params: { type: 'object' },
        file_path: { type: 'string' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const evaluation = kit.evaluation;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'evaluate':
          return { result: await evaluation.evaluate(str(requireArg(args, 'photo_path')), args['photo_id'] as string | undefined) };
        case 'evaluate_batch':
          return await evaluation.evaluateBatch(requireArg<string[]>(args, 'photo_paths'));
        case 'live_feedback':
          return await evaluation.liveFeedback(str(requireArg(args, 'frame_path')), args['target_params'] as Record<string, unknown> | undefined);
        case 'set_camera_file': {
          const { FileFallbackCapture } = await import('./photography/evaluation.js');
          evaluation.setCamera(new FileFallbackCapture(str(requireArg(args, 'file_path'))));
          return { camera: 'file_fallback' };
        }
        case 'capture_and_evaluate':
          return await evaluation.captureAndEvaluate(args['photo_id'] as string | undefined);
        case 'capture_and_feedback':
          return await evaluation.captureAndFeedback(args['target_params'] as Record<string, unknown> | undefined);
        default:
          throw new Error(`未知的 evaluation action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // image_generate 图片生成(新增)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'image_generate',
      description: '图片生成工具(prompt 必填)。可选 model/size/quality/style/n;生成结果落盘并返回本地路径',
      inputSchema: makeSchema({
        prompt: { type: 'string', description: '生成提示词' },
        model: { type: 'string' },
        size: { type: 'string' },
        quality: { type: 'string' },
        style: { type: 'string' },
        n: { type: 'integer' },
        output_dir: { type: 'string' },
        file_name_prefix: { type: 'string' },
      }, ['prompt']),
      outputSchema: makeSchema({ images: { type: 'array', items: { type: 'object' } } }),
    },
    async (args) => {
      const request: ImageGenerationRequest = {
        prompt: str(requireArg(args, 'prompt')),
        model: args['model'] as string | undefined,
        size: args['size'] as string | undefined,
        quality: args['quality'] as string | undefined,
        style: args['style'] as string | undefined,
        n: optionalArg(args, 'n', 1),
        outputDir: (args['output_dir'] as string | undefined) ?? generatedDir,
        fileNamePrefix: args['file_name_prefix'] as string | undefined,
      };
      const images = await generation.generate(request);
      return { images, count: images.length };
    },
  );

  // ------------------------------------------------------------------
  // image_process 图像处理(新增)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'image_process',
      description: '图像处理工具。action: resize(input,{width,height,fit}) / crop(input,{left,top,width,height}) / rotate(input, angle) / flip(input,{vertical,horizontal}) / adjust(input, adjustments{brightness,contrast,saturation,sharpness,temperature,gamma,hue,blur}) / convert(input,{format,quality}) / watermark(input, watermark_path, {gravity,scale,opacity}) / info(input)',
      inputSchema: makeSchema({
        action: { type: 'string', enum: ['resize', 'crop', 'rotate', 'flip', 'adjust', 'convert', 'watermark', 'info'] },
        input: { type: 'string' },
        output: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        fit: { type: 'string' },
        left: { type: 'integer' },
        top: { type: 'integer' },
        angle: { type: 'number' },
        vertical: { type: 'boolean' },
        horizontal: { type: 'boolean' },
        adjustments: { type: 'object' },
        format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'tiff', 'avif', 'gif'] },
        quality: { type: 'integer' },
        watermark_path: { type: 'string' },
        gravity: { type: 'string' },
        scale: { type: 'number' },
        opacity: { type: 'number' },
      }, ['action', 'input']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const processing = kit.processing;
      const action = str(requireArg(args, 'action'));
      const input = str(requireArg(args, 'input'));
      const output = args['output'] as string | undefined;
      switch (action) {
        case 'resize':
          return { result: await processing.resize(input, {
            width: optionalArg(args, 'width', undefined),
            height: optionalArg(args, 'height', undefined),
            fit: optionalArg(args, 'fit', 'cover'),
          }, output) };
        case 'crop':
          return { result: await processing.crop(input, {
            left: num(requireArg(args, 'left')),
            top: num(requireArg(args, 'top')),
            width: num(requireArg(args, 'width')),
            height: num(requireArg(args, 'height')),
          }, output) };
        case 'rotate':
          return { result: await processing.rotate(input, num(requireArg(args, 'angle')), output) };
        case 'flip':
          return { result: await processing.flip(input, {
            vertical: optionalArg(args, 'vertical', false),
            horizontal: optionalArg(args, 'horizontal', false),
          }, output) };
        case 'adjust':
          return { result: await processing.adjust(input, requireArg<Partial<ImageAdjustments>>(args, 'adjustments'), output) };
        case 'convert':
          return { result: await processing.convert(input, {
            format: requireArg(args, 'format'),
            quality: optionalArg(args, 'quality', undefined),
          }, output) };
        case 'watermark':
          return { result: await processing.watermark(input, str(requireArg(args, 'watermark_path')), {
            gravity: args['gravity'] as never,
            scale: optionalArg(args, 'scale', undefined),
            opacity: optionalArg(args, 'opacity', undefined),
          }, output) };
        case 'info':
          return { metadata: await processing.info(input) };
        default:
          throw new Error(`未知的 image_process action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // image_analyze 图像解析(新增)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'image_analyze',
      description: '图像解析工具:解析格式/尺寸/EXIF/拍摄时间/色彩统计/自动标签',
      inputSchema: makeSchema({
        input: { type: 'string', description: '图片文件路径' },
      }, ['input']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const parsed = await kit.analysis.parse(str(requireArg(args, 'input')));
      return { result: parsed };
    },
  );

  // ------------------------------------------------------------------
  // thumbnail 缩略图(新增)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'thumbnail',
      description: '缩略图工具。action: generate(input, asset_id, sizes?) / get(asset_id, size) / remove(asset_id)。sizes: small(256)/medium(640)/large(1280)',
      inputSchema: makeSchema({
        action: { type: 'string', enum: ['generate', 'get', 'remove'] },
        input: { type: 'string' },
        asset_id: { type: 'string' },
        sizes: { type: 'array', items: { type: 'string', enum: ['small', 'medium', 'large'] } },
        size: { type: 'string' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const thumbnails = kit.thumbnails;
      const action = str(requireArg(args, 'action'));
      const assetId = str(requireArg(args, 'asset_id'));
      switch (action) {
        case 'generate': {
          const paths = await thumbnails.generate(
            str(requireArg(args, 'input')),
            assetId,
            optionalArg(args, 'sizes', undefined),
          );
          return { thumbnails: paths };
        }
        case 'get': {
          const path = thumbnails.get(assetId, str(requireArg(args, 'size')) as 'small' | 'medium' | 'large');
          if (!path) {
            throw new Error(`缩略图不存在: ${assetId}/${str(args['size'])}`);
          }
          return { path };
        }
        case 'remove':
          await thumbnails.remove(assetId);
          return { removed: true };
        default:
          throw new Error(`未知的 thumbnail action: ${action}`);
      }
    },
  );

  // ------------------------------------------------------------------
  // image_store 存储管理(新增)
  // ------------------------------------------------------------------
  iface.registerTool(
    {
      name: 'image_store',
      description: '图片存储管理工具。action: ingest(input, {file_name?,tags?,scene_type?,dedupe?,with_thumbnails?}) / get(asset_id) / query(filters?,page?,page_size?,sort_by?,sort_order?) / add_tag / remove_tag / set_scene / set_rating / remove(asset_id, delete_files?) / stats / cleanup / persist',
      inputSchema: makeSchema({
        action: { type: 'string' },
        input: { type: 'string' },
        options: { type: 'object' },
        asset_id: { type: 'string' },
        filters: { type: 'object' },
        page: { type: 'integer' },
        page_size: { type: 'integer' },
        sort_by: { type: 'string' },
        sort_order: { type: 'string' },
        tag: { type: 'string' },
        scene_type: { type: 'string' },
        rating: { type: 'integer' },
        delete_files: { type: 'boolean' },
      }, ['action']),
      outputSchema: makeSchema({ result: { type: 'object' } }),
    },
    async (args) => {
      const store = kit.store;
      const action = str(requireArg(args, 'action'));
      switch (action) {
        case 'ingest': {
          const options = optionalArg<Record<string, unknown>>(args, 'options', {});
          return await store.ingest(str(requireArg(args, 'input')), {
            fileName: options['file_name'] as string | undefined,
            tags: options['tags'] as string[] | undefined,
            sceneType: options['scene_type'] as string | undefined,
            autoTag: options['auto_tag'] as boolean | undefined,
            dedupe: options['dedupe'] as boolean | undefined,
            withThumbnails: options['with_thumbnails'] as boolean | undefined,
          });
        }
        case 'get': {
          const asset = store.get(str(requireArg(args, 'asset_id')));
          if (!asset) {
            throw new Error(`照片不存在: ${str(args['asset_id'])}`);
          }
          return { asset };
        }
        case 'query':
          return await store.query({
            filters: args['filters'] as never,
            page: optionalArg(args, 'page', 1),
            pageSize: optionalArg(args, 'page_size', 20),
            sortBy: optionalArg(args, 'sort_by', 'created_at'),
            sortOrder: optionalArg(args, 'sort_order', 'desc'),
          });
        case 'add_tag':
          return { asset: await store.addTag(str(requireArg(args, 'asset_id')), str(requireArg(args, 'tag'))) };
        case 'remove_tag':
          return { asset: await store.removeTag(str(requireArg(args, 'asset_id')), str(requireArg(args, 'tag'))) };
        case 'set_scene':
          return { asset: await store.setSceneType(str(requireArg(args, 'asset_id')), str(requireArg(args, 'scene_type'))) };
        case 'set_rating':
          return { asset: await store.setRating(str(requireArg(args, 'asset_id')), num(requireArg(args, 'rating'))) };
        case 'remove':
          return { removed: await store.remove(str(requireArg(args, 'asset_id')), { deleteFiles: optionalArg(args, 'delete_files', true) }) };
        case 'stats':
          return store.stats();
        case 'cleanup':
          return await store.cleanupOrphans();
        case 'persist':
          await store.persist();
          return { persisted: true };
        default:
          throw new Error(`未知的 image_store action: ${action}`);
      }
    },
  );
}

export type { ToolDefinition };
