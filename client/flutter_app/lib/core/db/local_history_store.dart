import "../models/chat_models.dart";

abstract class LocalHistoryStore {
  Future<void> init();
  Future<void> saveSession(ChatSession session);
  Future<void> saveMessage(ChatMessage message);
  Future<List<ChatSession>> listSessions();
  Future<List<ChatMessage>> listMessages(String sessionId);
  
  // Preference 存储
  Future<dynamic> getPreference(String key);
  Future<void> savePreference(String key, dynamic value);
  
  // 生物特征注册状态
  Future<bool> getBiometricRegistrationStatus();
  Future<void> saveBiometricRegistrationStatus(bool isRegistered);
}
