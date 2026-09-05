/** 摄影 Agent 能力移植测试:presets / guidance / habit / evaluation */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PresetService,
  GuidanceService,
  HabitService,
  EvaluationService,
  FileFallbackCapture,
} from '../src/index.js';
import { createTestImage, cleanupDir } from './helpers.js';

test('PresetService:内置预设不可删,自定义预设可保存/删除', () => {
  const presets = new PresetService();
  const builtins = presets.listPresets({ builtinOnly: true });
  assert.equal(builtins.length, 5);
  assert.ok(presets.getPreset('builtin_outdoor_portrait'));

  assert.throws(() => presets.deletePreset('builtin_landscape'));

  const custom = presets.savePreset(
    '自定义',
    'indoor_portrait',
    { focalLength: 35, aperture: 1.8, shootingDistance: 2 },
    { rule: 'diagonal', overlayDescription: '对角线', textAdvice: '建议' },
    null,
    { contrast: 10 },
    ['test'],
  );
  assert.equal(presets.listPresets({ customOnly: true }).length, 1);
  assert.equal(presets.applyPreset(custom.id).name, '自定义');
  assert.equal(presets.deletePreset(custom.id), true);
});

test('GuidanceService:镜头/构图/动作/偏差反馈', () => {
  const guidance = new GuidanceService();
  const lens = guidance.guideLens('closeup');
  assert.equal(lens.focalLength, 85);
  assert.equal(lens.aperture, 1.8);
  assert.throws(() => guidance.guideLens('unknown'));

  assert.equal(guidance.guideComposition('golden_ratio').rule, 'golden_ratio');
  assert.throws(() => guidance.guideComposition('nope'));

  assert.equal(guidance.guidePose('walking').poseName, 'walking');
  assert.equal(guidance.listPoses().length, 5);

  const deviation = guidance.checkDeviation(
    { distance: 5, subject_position: 'left', horizon_angle: 10, brightness: 40 },
    { distance: 2, subject_position: 'center', horizon_angle: 0, brightness: 120 },
  );
  assert.equal(deviation.adjustments.length, 4);
  assert.deepEqual(guidance.realTimeFeedback({ brightness: 10 }, { brightness: 12 }), []);

  const full = guidance.fullGuidance({ shootingTarget: 'full_body', sceneType: 'street', poseName: 'walking' });
  assert.equal(full.lens!.focalLength, 35);
  assert.equal(full.pose!.poseName, 'walking');
  assert.ok(full.sceneOverlay);
});

test('HabitService:拍摄/批图历史学习与推荐', () => {
  const habit = new HabitService();
  habit.recordShooting('u1', 85, 'thirds', 'outdoor_portrait');
  habit.recordShooting('u1', 85, 'thirds', 'landscape');
  habit.recordShooting('u1', 24, 'leading_lines', 'landscape');

  const profile = habit.learnShootingPreference('u1');
  assert.deepEqual(profile.preferredFocalLengths, [85, 24]);
  assert.deepEqual(profile.preferredCompositionRules, ['thirds', 'leading_lines']);
  assert.equal(profile.preferredSceneTypes[0], 'landscape');

  const batch = habit.recordBatchAdjustment('u1', { brightness: 5, contrast: 10 }, { brightness: 15, contrast: 10 });
  assert.equal(batch.delta['brightness'], 10);
  assert.equal(batch.delta['contrast'], 0);

  const style = habit.learnBatchStyle('u1');
  assert.equal(style.sampleCount, 1);
  assert.equal(style.avgDelta['brightness'], 10);

  const updated = habit.updateHabitBatchStyle('u1');
  assert.equal(updated.batchStyleAvg['brightness'], 10);

  const recommend = habit.recommend('u1', {});
  assert.equal(recommend.recommended.recommendedFocalLength, 85);
  assert.equal(recommend.recommended.recommendedComposition, 'thirds');
  assert.equal(recommend.recommended.recommendedBatchStyle['brightness'], 10);
  assert.equal(recommend.confidence, 0.3);
  assert.equal(recommend.basedOnRecords, 3);

  // 无历史用户:按场景给默认焦段
  const fresh = habit.recommend('u2', { sceneType: 'landscape' });
  assert.equal(fresh.recommended.recommendedFocalLength, 24);
});

test('EvaluationService:评分启发式与实时反馈', async (t) => {
  // 评分函数纯逻辑校验
  assert.equal(EvaluationService.exposureScore(130), 100);
  assert.ok(EvaluationService.exposureScore(10) < 50);
  assert.equal(EvaluationService.compositionScore(3000, 2000), 90);
  assert.equal(EvaluationService.compositionScore(1000, 1000), 75);
  assert.equal(EvaluationService.compositionScore(1920, 1080), 85);
  assert.equal(EvaluationService.subjectScore(100), 100);
  assert.equal(EvaluationService.sharpnessScore(0), 20);

  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-eval-'));
  t.after(() => cleanupDir(dir));

  // 暗图曝光分低
  const dark = join(dir, 'dark.png');
  await createTestImage(dark, { width: 3000, height: 2000, r: 15, g: 15, b: 15 });
  const evaluation = new EvaluationService();
  const result = await evaluation.evaluate(dark);
  assert.equal(result.compositionScore, 90);
  assert.ok(result.exposureScore < 60);
  assert.ok(result.suggestions.some((s) => s.includes('偏暗')));

  // FileFallbackCapture + liveFeedback(均值 130 落在理想曝光区)
  const normal = join(dir, 'normal.png');
  await createTestImage(normal, { width: 3000, height: 2000, r: 130, g: 130, b: 130 });
  const withCamera = new EvaluationService(new FileFallbackCapture(normal));
  const captured = await withCamera.captureAndFeedback({ distance: 2 });
  assert.equal(captured.framePath, normal);
  assert.ok(captured.evaluation.exposureScore >= 90);

  const feedback = await evaluation.liveFeedback(normal);
  assert.ok(Array.isArray(feedback.hints));
});
