import "dart:async";

/// 命令回调类型
typedef CommandCallback = void Function(String command, Map<String, dynamic> params);

/// 语音命令处理器
class VoiceCommandProcessor {
  static final VoiceCommandProcessor _instance = VoiceCommandProcessor._internal();
  
  factory VoiceCommandProcessor() {
    return _instance;
  }
  
  VoiceCommandProcessor._internal();

  static VoiceCommandProcessor get instance => _instance;

  /// 注册的命令处理器
  final Map<String, CommandCallback> _commandHandlers = {};

  /// 初始化默认命令
  void initializeDefaultCommands() {
    // 天气查询
    registerCommand("weather", (command, params) {
      print("执行命令: 查询天气");
      // TODO: 集成天气API
    });

    // 设置闹钟
    registerCommand("alarm", (command, params) {
      print("执行命令: 设置闹钟 - ${params['time']}");
      // TODO: 集成闹钟功能
    });

    // 发送消息
    registerCommand("message", (command, params) {
      print("执行命令: 发送消息给 ${params['recipient']}");
      // TODO: 集发消息功能
    });

    // 播放音乐
    registerCommand("music", (command, params) {
      print("执行命令: 播放音乐 - ${params['song']}");
      // TODO: 集成音乐播放器
    });

    // 查询日程
    registerCommand("schedule", (command, params) {
      print("执行命令: 查询日程");
      // TODO: 集成日程查询
    });

    // 打开应用
    registerCommand("open_app", (command, params) {
      print("执行命令: 打开应用 - ${params['app_name']}");
      // TODO: 集成应用启动
    });
  }

  /// 注册命令处理器
  void registerCommand(String commandName, CommandCallback handler) {
    _commandHandlers[commandName.toLowerCase()] = handler;
  }

  /// 处理语音命令
  Future<void> processCommand(String recognizedText) async {
    print("处理语音命令: $recognizedText");

    // 简单的命令匹配逻辑（实际应用中需要使用NLP）
    final command = _parseCommand(recognizedText);
    
    if (command != null) {
      final handler = _commandHandlers[command['name']?.toLowerCase()];
      if (handler != null) {
        handler(command['name']!, command['params'] ?? {});
      } else {
        print("未找到命令处理器: ${command['name']}");
      }
    } else {
      print("无法解析命令: $recognizedText");
    }
  }

  /// 解析命令（简化版，实际应使用NLP）
  Map<String, dynamic>? _parseCommand(String text) {
    final lowerText = text.toLowerCase();

    // 天气相关
    if (lowerText.contains('天气') || lowerText.contains('weather')) {
      return {'name': 'weather', 'params': <String, dynamic>{}};
    }

    // 闹钟相关
    if (lowerText.contains('闹钟') || lowerText.contains('alarm')) {
      // 提取时间信息（简化）
      final timeMatch = RegExp(r'(\d+)[点:](\d+)').firstMatch(text);
      final params = <String, dynamic>{};
      if (timeMatch != null) {
        params['time'] = '${timeMatch.group(1)}:${timeMatch.group(2)}';
      }
      return {'name': 'alarm', 'params': params};
    }

    // 发消息相关
    if (lowerText.contains('发消息') || lowerText.contains('send message')) {
      // 提取收件人（简化）
      final recipientMatch = RegExp(r'给(.+?)发').firstMatch(text);
      final params = <String, dynamic>{};
      if (recipientMatch != null) {
        params['recipient'] = recipientMatch.group(1);
      }
      return {'name': 'message', 'params': params};
    }

    // 音乐相关
    if (lowerText.contains('音乐') || lowerText.contains('play music')) {
      final params = <String, dynamic>{'song': '随机播放'};
      return {'name': 'music', 'params': params};
    }

    // 日程相关
    if (lowerText.contains('日程') || lowerText.contains('schedule')) {
      return {'name': 'schedule', 'params': <String, dynamic>{}};
    }

    // 打开应用
    if (lowerText.contains('打开') || lowerText.contains('open')) {
      final appMatch = RegExp(r'打开(.+)').firstMatch(text);
      final params = <String, dynamic>{};
      if (appMatch != null) {
        params['app_name'] = appMatch.group(1);
      }
      return {'name': 'open_app', 'params': params};
    }

    return null;
  }

  /// 获取支持的命令列表
  List<String> getSupportedCommands() {
    return _commandHandlers.keys.toList();
  }

  /// 清除所有命令处理器
  void clearCommands() {
    _commandHandlers.clear();
  }
}
