import 'package:flutter_test/flutter_test.dart';
import 'package:private_ai_agent/core/presentation/dynamic_island.dart';

void main() {
  // 渲染端已迁至原生 C++ 分层窗口；Dart 侧保留状态大脑的确定性测试。
  group('DynamicIslandController 优先级仲裁', () {
    test('高优先级抢占，被抢占者回队列', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'update', title: '更新', kind: IslandKind.update, priority: 1));
      expect(c.entry?.id, 'task');

      c.present(const IslandEntry(
          id: 'schedule',
          title: '日程',
          kind: IslandKind.schedule,
          priority: -1));
      expect(c.entry?.id, 'schedule');

      c.dismiss('schedule');
      // FIFO：先入队的 update 先露面，被抢占的 task 随后回来。
      expect(c.entry?.id, 'update');
      c.dismiss('update');
      expect(c.entry?.id, 'task');
    });

    test('同优先级后来者排队不抢屏，FIFO 轮播且队列有界', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'a', title: 'A', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'b', title: 'B', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'd', title: 'D', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'e', title: 'E', kind: IslandKind.schedule, priority: 2));
      expect(c.entry?.id, 'a');
      c.dismiss('a');
      // FIFO：最早入队的 b 先露面。
      expect(c.entry?.id, 'b');
      // 继续灌队触发容量 3 淘汰：当前队列 [d,e] → f → [d,e,f] → g 挤掉 d。
      c.present(const IslandEntry(
          id: 'f', title: 'F', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'g', title: 'G', kind: IslandKind.schedule, priority: 2));
      c.dismiss('b');
      expect(c.entry?.id, 'e');
    });

    test('dismissAll 清空一切，同 id 原地刷新', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'update', title: '更新', kind: IslandKind.update, priority: 1));
      c.dismissAll();
      expect(c.entry, isNull);

      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'task',
          title: '任务刷新',
          kind: IslandKind.task,
          priority: 0,
          trailing: "3′0″"));
      expect(c.entry?.id, 'task');
      expect(c.entry?.title, '任务刷新');
    });

    test('低优先级不抢占高优先级，只入队', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'inbox', title: '未读', kind: IslandKind.inbox, priority: 2));
      expect(c.entry?.id, 'task');
      c.dismiss('task');
      expect(c.entry?.id, 'inbox');
    });
  });
}
