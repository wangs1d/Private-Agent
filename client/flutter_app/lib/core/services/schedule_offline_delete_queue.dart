import "../db/isar_local_history_store.dart";
import "schedule_api_client.dart";

/// 离线删除队列 flush 结果。
class ScheduleOfflineDeleteFlushResult {
  const ScheduleOfflineDeleteFlushResult({
    required this.flushed,
    required this.pending,
    this.networkUnavailable = false,
  });

  /// 本次成功同步到服务端的删除数。
  final int flushed;

  /// 仍待补删的数量。
  final int pending;

  /// 主服务不可达，未尝试删除。
  final bool networkUnavailable;
}

/// 用户本地删除服务端日程时入队，待主服务恢复后补删。
Future<void> enqueueScheduleOfflineDelete(
  IsarLocalHistoryStore store,
  String taskId,
) async {
  await store.enqueuePendingScheduleDelete(taskId);
}

/// 服务端已确认删除，移出离线队列。
Future<void> dequeueScheduleOfflineDelete(
  IsarLocalHistoryStore store,
  String taskId,
) async {
  await store.dequeuePendingScheduleDelete(taskId);
}

/// 重试队列中所有待删 taskId；主服务不可达时直接返回。
Future<ScheduleOfflineDeleteFlushResult> flushScheduleOfflineDeleteQueue(
  IsarLocalHistoryStore store,
  ScheduleApiClient api,
) async {
  final Set<String> pending = await store.getPendingScheduleDeleteTaskIds();
  if (pending.isEmpty) {
    return const ScheduleOfflineDeleteFlushResult(flushed: 0, pending: 0);
  }

  if (!await api.isReachable()) {
    return ScheduleOfflineDeleteFlushResult(
      flushed: 0,
      pending: pending.length,
      networkUnavailable: true,
    );
  }

  int flushed = 0;
  for (final String taskId in pending.toList()) {
    final ScheduleApiResult<void> result = await api.deleteScheduleTask(taskId);
    if (result.ok) {
      await store.dequeuePendingScheduleDelete(taskId);
      flushed += 1;
    }
  }

  final int remaining = (await store.getPendingScheduleDeleteTaskIds()).length;
  return ScheduleOfflineDeleteFlushResult(flushed: flushed, pending: remaining);
}
