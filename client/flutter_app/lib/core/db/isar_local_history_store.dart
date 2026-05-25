import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter/foundation.dart" show kIsWeb;
import "package:path_provider/path_provider.dart";

import "../models/agent_relay_models.dart";
import "../models/chat_models.dart";
import "../models/schedule_models.dart";
import "local_history_store.dart";

class IsarLocalHistoryStore implements LocalHistoryStore {
  IsarLocalHistoryStore({required String userPin}) : _userPin = userPin;

  String _userPin;

  /// 当前本地加密口令（与聊天、入站中继 XOR 密钥同源）。
  String get userPin => _userPin;
  final List<ChatSession> _sessions = <ChatSession>[];
  final Map<String, List<ChatMessage>> _messages = <String, List<ChatMessage>>{};
  /// 入站中继：按本机 `sessionId`（收件人）分桶；正文与主题经与聊天相同的 XOR 混淆后写入。
  final Map<String, List<Map<String, dynamic>>> _relayInbound =
      <String, List<Map<String, dynamic>>>{};
  File? _storageFile;
  /// 扩展偏好（明文；不走聊天 XOR）。
  Map<String, dynamic> _preferences = <String, dynamic>{};
  /// 日程事项（明文 JSON；按条存储）。
  final List<Map<String, dynamic>> _scheduleEvents =
      <Map<String, dynamic>>[];

  @override
  Future<void> init() async {
    if (_storageFile != null) return;
    
    // Web 平台不支持文件系统，使用内存存储
    if (kIsWeb) {
      print('[IsarLocalHistoryStore] Web 平台 detected, using memory storage');
      _storageFile = null; // Web 平台不使用文件
      // 初始化空数据结构
      _preferences = <String, dynamic>{};
      return;
    }
    
    // 非 Web 平台使用文件系统
    final dir = await getApplicationDocumentsDirectory();
    _storageFile = File("${dir.path}/private_ai_agent_store.json");
    if (!await _storageFile!.exists()) {
      await _storageFile!.writeAsString(
        jsonEncode(<String, dynamic>{
          "sessions": <Map<String, dynamic>>[],
          "messages": <String, List<Map<String, dynamic>>>{},
          "relayInbound": <String, List<Map<String, dynamic>>>{},
          "preferences": <String, dynamic>{},
          "scheduleEvents": <Map<String, dynamic>>[],
        }),
      );
      return;
    }
    final String raw = await _storageFile!.readAsString();
    if (raw.trim().isEmpty) return;
    final Map<String, dynamic> decoded = jsonDecode(raw) as Map<String, dynamic>;
    final List<dynamic> sessionRaw = decoded["sessions"] as List<dynamic>? ?? <dynamic>[];
    _sessions
      ..clear()
      ..addAll(
        sessionRaw.map((dynamic s) {
          final Map<String, dynamic> map = s as Map<String, dynamic>;
          return ChatSession(
            sessionId: map["sessionId"] as String,
            title: map["title"] as String,
            createdAt: DateTime.parse(map["createdAt"] as String),
          );
        }),
      );
    final Map<String, dynamic> messagesRaw =
        decoded["messages"] as Map<String, dynamic>? ?? <String, dynamic>{};
    _messages.clear();
    for (final MapEntry<String, dynamic> entry in messagesRaw.entries) {
      final List<dynamic> list = entry.value as List<dynamic>;
      _messages[entry.key] = list.map((dynamic m) {
        final Map<String, dynamic> map = m as Map<String, dynamic>;
        return ChatMessage(
          messageId: map["messageId"] as String,
          sessionId: map["sessionId"] as String,
          role: map["role"] as String,
          text: map["text"] as String,
          timestamp: DateTime.parse(map["timestamp"] as String),
          attachmentImageCount: (map["attachmentImageCount"] as num?)?.toInt() ?? 0,
          playUrl: map["playUrl"] as String?,
        );
      }).toList();
    }
    final Map<String, dynamic> relayRaw =
        decoded["relayInbound"] as Map<String, dynamic>? ?? <String, dynamic>{};
    _relayInbound.clear();
    for (final MapEntry<String, dynamic> entry in relayRaw.entries) {
      final List<dynamic> list = entry.value as List<dynamic>? ?? <dynamic>[];
      _relayInbound[entry.key] = list
          .map((dynamic m) => Map<String, dynamic>.from(m as Map))
          .toList();
    }
    _preferences = Map<String, dynamic>.from(
      decoded["preferences"] as Map<String, dynamic>? ?? <String, dynamic>{},
    );
    final List<dynamic> schedRaw =
        decoded["scheduleEvents"] as List<dynamic>? ?? <dynamic>[];
    _scheduleEvents
      ..clear()
      ..addAll(
        schedRaw.map(
          (dynamic e) => Map<String, dynamic>.from(e as Map),
        ),
      );
  }

  /// 某自然日内的日程（按开始时间升序）。
  Future<List<ScheduleEvent>> listScheduleEventsForDay(DateTime day) async {
    await init();
    final DateTime start =
        DateTime(day.year, day.month, day.day);
    final DateTime end = start.add(const Duration(days: 1));
    final List<ScheduleEvent> out = _scheduleEvents
        .map(_scheduleEventFromMap)
        .where(
          (ScheduleEvent e) =>
              !e.startAt.isBefore(start) && e.startAt.isBefore(end),
        )
        .toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  /// 左闭右开区间 [startInclusive, endExclusive) 内的日程，按开始时间升序。
  Future<List<ScheduleEvent>> listScheduleEventsInRange(
    DateTime startInclusive,
    DateTime endExclusive,
  ) async {
    await init();
    final List<ScheduleEvent> out = _scheduleEvents
        .map(_scheduleEventFromMap)
        .where(
          (ScheduleEvent e) =>
              !e.startAt.isBefore(startInclusive) &&
              e.startAt.isBefore(endExclusive),
        )
        .toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  /// 全部本地日程（按开始时间升序），供「事项管理」列表使用。
  Future<List<ScheduleEvent>> listAllScheduleEvents() async {
    await init();
    final List<ScheduleEvent> out =
        _scheduleEvents.map(_scheduleEventFromMap).toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  Future<void> saveScheduleEvent(ScheduleEvent event) async {
    await init();
    final Map<String, dynamic> map = _scheduleEventToMap(event);
    final int idx =
        _scheduleEvents.indexWhere((Map<String, dynamic> m) => m["id"] == event.id);
    if (idx >= 0) {
      _scheduleEvents[idx] = map;
    } else {
      _scheduleEvents.add(map);
    }
    await _flush();
  }

  Future<void> deleteScheduleEvent(String id) async {
    await init();
    _scheduleEvents.removeWhere((Map<String, dynamic> m) => m["id"] == id);
    await _flush();
  }

  /// 删除同一服务端任务展开出的全部本地事项（id 为 `taskId` 或 `taskId@…`）。
  Future<void> deleteScheduleEventsForTask(String taskId) async {
    await init();
    _scheduleEvents.removeWhere((Map<String, dynamic> m) {
      final String id = m["id"] as String;
      return id == taskId || id.startsWith("$taskId@");
    });
    await _flush();
  }

  Future<void> clearAllScheduleEvents() async {
    await init();
    _scheduleEvents.clear();
    await _flush();
  }

  /// 用户已删除的服务端 taskId（同步时跳过，防止被重新拉回）。
  Future<Set<String>> getHiddenScheduleTaskIds() async {
    await init();
    final Object? raw = _preferences["hiddenScheduleTaskIds"];
    if (raw is! List) return <String>{};
    final Set<String> out = <String>{};
    for (final Object? item in raw) {
      final String s = item?.toString().trim() ?? "";
      if (s.isNotEmpty) out.add(s);
    }
    return out;
  }

  Future<void> hideScheduleTask(String taskId) async {
    final String id = taskId.trim();
    if (id.isEmpty) return;
    await init();
    final Set<String> hidden = await getHiddenScheduleTaskIds();
    hidden.add(id);
    _preferences["hiddenScheduleTaskIds"] = hidden.toList();
    await _flush();
  }

  ScheduleEvent _scheduleEventFromMap(Map<String, dynamic> m) {
    return ScheduleEvent(
      id: m["id"] as String,
      startAt: DateTime.parse(m["startAt"] as String),
      title: m["title"] as String,
      notes: m["notes"] as String?,
    );
  }

  Map<String, dynamic> _scheduleEventToMap(ScheduleEvent e) {
    return <String, dynamic>{
      "id": e.id,
      "startAt": e.startAt.toIso8601String(),
      "title": e.title,
      "notes": e.notes,
    };
  }

  /// `null`：尚未询问；`true`/`false`：用户已选择。
  Future<bool?> getVisionCameraConsent() async {
    await init();
    final Object? v = _preferences["visionCameraConsent"];
    if (v == null) {
      return null;
    }
    return v == true;
  }

  Future<void> setVisionCameraConsent(bool allowed) async {
    await init();
    _preferences["visionCameraConsent"] = allowed;
    await _flush();
  }

  /// 解密后的入站中继，按接收时间降序。
  Future<List<AgentRelayMessage>> listRelayInbound(String ownerSessionId) async {
    await init();
    final List<Map<String, dynamic>> raw =
        _relayInbound[ownerSessionId] ?? <Map<String, dynamic>>[];
    final List<AgentRelayMessage> out = raw.map(_mapToRelayPlain).toList();
    out.sort((AgentRelayMessage a, AgentRelayMessage b) =>
        b.receivedAt.compareTo(a.receivedAt));
    return out;
  }

  Future<void> upsertRelayMessage(String ownerSessionId, AgentRelayMessage m) async {
    await init();
    if (m.toSessionId != ownerSessionId) return;
    final List<Map<String, dynamic>> list =
        _relayInbound.putIfAbsent(ownerSessionId, () => <Map<String, dynamic>>[]);
    final Map<String, dynamic> encoded = _relayToMapEncrypted(m);
    final int idx = list.indexWhere(
      (Map<String, dynamic> r) => r["messageId"] == m.messageId,
    );
    if (idx >= 0) {
      list[idx] = encoded;
    } else {
      list.add(encoded);
    }
    list.sort((Map<String, dynamic> a, Map<String, dynamic> b) {
      final DateTime ta = DateTime.parse(a["receivedAt"] as String);
      final DateTime tb = DateTime.parse(b["receivedAt"] as String);
      return tb.compareTo(ta);
    });
    await _flush();
  }

  Future<void> replaceRelayInbound(
    String ownerSessionId,
    List<AgentRelayMessage> messages,
  ) async {
    await init();
    final List<Map<String, dynamic>> next = messages
        .where((AgentRelayMessage m) => m.toSessionId == ownerSessionId)
        .map(_relayToMapEncrypted)
        .toList();
    next.sort((Map<String, dynamic> a, Map<String, dynamic> b) {
      final DateTime ta = DateTime.parse(a["receivedAt"] as String);
      final DateTime tb = DateTime.parse(b["receivedAt"] as String);
      return tb.compareTo(ta);
    });
    _relayInbound[ownerSessionId] = next;
    await _flush();
  }

  Map<String, dynamic> _relayToMapEncrypted(AgentRelayMessage m) {
    return _relayToMapEncryptedFor(m, _userPin);
  }

  Map<String, dynamic> _relayToMapEncryptedFor(AgentRelayMessage m, String pin) {
    return <String, dynamic>{
      "messageId": m.messageId,
      "fromSessionId": m.fromSessionId,
      "toSessionId": m.toSessionId,
      "text": _encryptFor(m.text, pin),
      "subject": m.subject == null ? null : _encryptFor(m.subject!, pin),
      "receivedAt": m.receivedAt.toIso8601String(),
    };
  }

  AgentRelayMessage _mapToRelayPlain(Map<String, dynamic> map) {
    return _mapToRelayPlainFor(map, _userPin);
  }

  AgentRelayMessage _mapToRelayPlainFor(Map<String, dynamic> map, String pin) {
    final String? subCipher = map["subject"] as String?;
    return AgentRelayMessage(
      messageId: map["messageId"] as String,
      fromSessionId: map["fromSessionId"] as String,
      toSessionId: map["toSessionId"] as String,
      text: _decryptFor(map["text"] as String, pin),
      subject: subCipher == null || subCipher.isEmpty
          ? null
          : _decryptFor(subCipher, pin),
      receivedAt: DateTime.parse(map["receivedAt"] as String),
    );
  }

  /// 将本地数据用旧 PIN 解密后再用新 PIN 加密并落盘（聊天 + 入站中继）。
  Future<void> rekey(String newPin) async {
    await init();
    final String trimmed = newPin.trim();
    if (trimmed.length < 4) {
      throw ArgumentError("新 PIN 至少 4 个字符");
    }
    if (trimmed == _userPin) return;
    final String oldPin = _userPin;

    for (final String sid in _messages.keys.toList()) {
      final List<ChatMessage> list = _messages[sid]!;
      for (int i = 0; i < list.length; i++) {
        final ChatMessage m = list[i];
        final String plain = _decryptFor(m.text, oldPin);
        final String enc = _encryptFor(plain, trimmed);
        list[i] = ChatMessage(
          messageId: m.messageId,
          sessionId: m.sessionId,
          role: m.role,
          text: enc,
          timestamp: m.timestamp,
          attachmentImageCount: m.attachmentImageCount,
          playUrl: m.playUrl,
        );
      }
    }

    for (final String owner in _relayInbound.keys.toList()) {
      final List<Map<String, dynamic>> list = _relayInbound[owner]!;
      for (int i = 0; i < list.length; i++) {
        final AgentRelayMessage plain = _mapToRelayPlainFor(list[i], oldPin);
        list[i] = _relayToMapEncryptedFor(plain, trimmed);
      }
    }

    _userPin = trimmed;
    await _flush();
  }

  @override
  Future<List<ChatMessage>> listMessages(String sessionId) async {
    await init();
    final List<ChatMessage> encrypted = _messages[sessionId] ?? <ChatMessage>[];
    encrypted.sort((ChatMessage a, ChatMessage b) => a.timestamp.compareTo(b.timestamp));
    return encrypted
        .map(
          (ChatMessage message) => ChatMessage(
            messageId: message.messageId,
            sessionId: message.sessionId,
            role: message.role,
            text: _decryptFor(message.text, _userPin),
            timestamp: message.timestamp,
            attachmentImageCount: message.attachmentImageCount,
            playUrl: message.playUrl,
          ),
        )
        .toList();
  }

  @override
  Future<List<ChatSession>> listSessions() async {
    await init();
    final List<ChatSession> sessions = List<ChatSession>.from(_sessions);
    sessions.sort((ChatSession a, ChatSession b) => a.createdAt.compareTo(b.createdAt));
    return sessions;
  }

  @override
  Future<void> saveMessage(ChatMessage message) async {
    await init();
    final String encrypted = _encryptFor(message.text, _userPin);
    final ChatMessage masked = ChatMessage(
      messageId: message.messageId,
      sessionId: message.sessionId,
      role: message.role,
      text: encrypted,
      timestamp: message.timestamp,
      attachmentImageCount: message.attachmentImageCount,
      playUrl: message.playUrl,
    );
    _messages.putIfAbsent(masked.sessionId, () => <ChatMessage>[]).add(masked);
    await _flush();
  }

  @override
  Future<void> saveSession(ChatSession session) async {
    await init();
    final bool exists = _sessions.any((ChatSession s) => s.sessionId == session.sessionId);
    if (exists) return;
    _sessions.add(session);
    await _flush();
  }

  String _encryptFor(String plainText, String pin) {
    final Digest key = sha256.convert(utf8.encode(pin));
    final List<int> source = utf8.encode(plainText);
    final List<int> output = <int>[];
    for (int i = 0; i < source.length; i++) {
      output.add(source[i] ^ key.bytes[i % key.bytes.length]);
    }
    return base64Encode(output);
  }

  String _decryptFor(String cipherText, String pin) {
    final Digest key = sha256.convert(utf8.encode(pin));
    final List<int> source = base64Decode(cipherText);
    final List<int> output = <int>[];
    for (int i = 0; i < source.length; i++) {
      output.add(source[i] ^ key.bytes[i % key.bytes.length]);
    }
    return utf8.decode(output);
  }

  Future<void> _flush() async {
    // Web 平台不支持文件系统，跳过写入
    if (kIsWeb || _storageFile == null) {
      print('[IsarLocalHistoryStore] Web 平台，跳过文件写入');
      return;
    }
    
    final File file = _storageFile!;
    final Map<String, dynamic> encoded = <String, dynamic>{
      "sessions": _sessions
          .map(
            (ChatSession s) => <String, dynamic>{
              "sessionId": s.sessionId,
              "title": s.title,
              "createdAt": s.createdAt.toIso8601String(),
            },
          )
          .toList(),
      "messages": _messages.map(
        (String key, List<ChatMessage> list) => MapEntry<String, dynamic>(
          key,
          list
              .map(
                (ChatMessage m) => <String, dynamic>{
                  "messageId": m.messageId,
                  "sessionId": m.sessionId,
                  "role": m.role,
                  "text": m.text,
                  "timestamp": m.timestamp.toIso8601String(),
                  "attachmentImageCount": m.attachmentImageCount,
                  if (m.playUrl != null) "playUrl": m.playUrl,
                },
              )
              .toList(),
        ),
      ),
      "relayInbound": _relayInbound,
      "preferences": _preferences,
      "scheduleEvents": _scheduleEvents,
    };
    await file.writeAsString(jsonEncode(encoded));
  }

  @override
  Future<dynamic> getPreference(String key) async {
    // 数据已在 init 时加载
    return _preferences[key];
  }

  @override
  Future<void> savePreference(String key, dynamic value) async {
    _preferences[key] = value;
    await _flush();
  }

  @override
  Future<bool> getBiometricRegistrationStatus() async {
    // 数据已在 init 时加载
    return _preferences['biometricRegistered'] == true;
  }

  @override
  Future<void> saveBiometricRegistrationStatus(bool isRegistered) async {
    _preferences['biometricRegistered'] = isRegistered;
    await _flush();
  }
}
