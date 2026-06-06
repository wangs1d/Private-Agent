import "dart:math" as math;
import "dart:convert";

/// 安全验证服务 - 管理会话令牌和安全验证
class SecurityService {
  static final SecurityService _instance = SecurityService._internal();
  
  factory SecurityService() {
    return _instance;
  }
  
  SecurityService._internal();

  static SecurityService get instance => _instance;

  String? _sessionToken;
  DateTime? _tokenExpiry;
  String? _currentUserId;
  
  // 最大失败尝试次数
  static const int maxFailedAttempts = 3;
  // 锁定时间（秒）
  static const int lockoutDuration = 300; // 5分钟
  
  final Map<String, int> _failedAttempts = {};
  final Map<String, DateTime> _lockoutTimes = {};

  /// 生成会话令牌
  String generateSessionToken(String userId) {
    final random = math.Random.secure();
    final bytes = List<int>.generate(32, (i) => random.nextInt(256));
    _sessionToken = base64UrlEncode(bytes);
    _currentUserId = userId;
    _tokenExpiry = DateTime.now().add(const Duration(hours: 1)); // 1小时过期
    
    print("生成会话令牌 for user: $userId");
    return _sessionToken!;
  }

  /// 验证会话令牌
  bool validateSessionToken(String token) {
    if (_sessionToken == null || _tokenExpiry == null) {
      return false;
    }

    // 检查令牌是否匹配
    if (_sessionToken != token) {
      return false;
    }

    // 检查是否过期
    if (DateTime.now().isAfter(_tokenExpiry!)) {
      _sessionToken = null;
      _tokenExpiry = null;
      return false;
    }

    return true;
  }

  /// 记录失败的验证尝试
  void recordFailedAttempt(String userId) {
    _failedAttempts[userId] = (_failedAttempts[userId] ?? 0) + 1;
    
    print("用户 $userId 失败尝试次数: ${_failedAttempts[userId]}");

    // 如果达到最大失败次数，锁定账户
    if (_failedAttempts[userId]! >= maxFailedAttempts) {
      _lockoutTimes[userId] = DateTime.now();
      print("用户 $userId 已被锁定 $lockoutDuration 秒");
    }
  }

  /// 检查账户是否被锁定
  bool isAccountLocked(String userId) {
    final lockoutTime = _lockoutTimes[userId];
    if (lockoutTime == null) {
      return false;
    }

    final now = DateTime.now();
    final elapsed = now.difference(lockoutTime).inSeconds;

    if (elapsed >= lockoutDuration) {
      // 锁定时间已过，解锁账户
      _lockoutTimes.remove(userId);
      _failedAttempts.remove(userId);
      return false;
    }

    return true;
  }

  /// 获取剩余锁定时间（秒）
  int getRemainingLockoutTime(String userId) {
    final lockoutTime = _lockoutTimes[userId];
    if (lockoutTime == null) {
      return 0;
    }

    final now = DateTime.now();
    final elapsed = now.difference(lockoutTime).inSeconds;
    final remaining = lockoutDuration - elapsed;

    return remaining > 0 ? remaining : 0;
  }

  /// 重置失败尝试计数
  void resetFailedAttempts(String userId) {
    _failedAttempts.remove(userId);
    _lockoutTimes.remove(userId);
  }

  /// 获取当前用户ID
  String? get currentUserId => _currentUserId;

  /// 获取当前会话令牌
  String? get sessionToken => _sessionToken;

  /// 清除会话
  void clearSession() {
    _sessionToken = null;
    _tokenExpiry = null;
    _currentUserId = null;
  }

  /// 获取安全状态信息
  Map<String, dynamic> getSecurityStatus(String userId) {
    return {
      'isLocked': isAccountLocked(userId),
      'failedAttempts': _failedAttempts[userId] ?? 0,
      'remainingLockoutTime': getRemainingLockoutTime(userId),
      'hasSession': _sessionToken != null && _currentUserId == userId,
    };
  }
}
