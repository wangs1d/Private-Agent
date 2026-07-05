/// 右侧抽屉要展示的内容种类。
enum RightPanelKind { friends, messages, notes, devices }

/// 顶栏标题占位（各 tab 标题均为空字符串，AppBar title 由其他逻辑驱动）。
const List<String> kTabTitles = <String>[
  "",
  "",
  "",
];

/// 从多行状态文本中取最后一行非空行，并截断到 120 字符。
String shortLiveStatusLine(String text) {
  final String trimmed = text.trim();
  if (trimmed.isEmpty) return "";
  final List<String> lines = trimmed
      .split(RegExp(r"\r?\n"))
      .map((String s) => s.trim())
      .where((String s) => s.isNotEmpty)
      .toList();
  String line = lines.isNotEmpty ? lines.last : trimmed;
  if (line.length > 120) {
    line = "${line.substring(0, 119)}…";
  }
  return line;
}

/// 判断工具名是否为「主控调用子 Agent」工具（两种命名风格兼容）。
bool isMasterInvokeSubAgentTool(String toolName) {
  final String n = toolName.trim();
  return n == "master.invoke_sub_agent" || n == "master_invoke_sub_agent";
}

/// 翻译目标语言的展示标签。
String translateLangLabel(String code) {
  switch (code) {
    case 'zh':
      return '中文';
    case 'en':
      return 'English';
    case 'ja':
      return '日本語';
    case 'ko':
      return '한국어';
    case 'fr':
      return 'Français';
    case 'de':
      return 'Deutsch';
    case 'es':
      return 'Español';
    case 'ru':
      return 'Русский';
    case 'zh-Hant':
      return '繁體';
    case 'auto':
      return '自动检测';
    default:
      return '中文';
  }
}

/// 平台标识 → 中文显示名。
String platformDisplayName(String platform) {
  switch (platform) {
    case "wechat":
      return "微信";
    case "qq":
      return "QQ";
    case "feishu":
      return "飞书";
    default:
      return "其他";
  }
}

/// 右侧面板标题。
String rightPanelTitle(RightPanelKind kind) {
  switch (kind) {
    case RightPanelKind.friends:
      return "好友";
    case RightPanelKind.messages:
      return "消息聚合";
    case RightPanelKind.notes:
      return "笔记";
    case RightPanelKind.devices:
      return "我的设备";
  }
}

/// 从 payload 中提取可用的异步确认操作列表。
List<String> confirmationActionsFor(Map<String, dynamic> payload) {
  final List<dynamic> raw =
      payload["availableActions"] as List<dynamic>? ?? <dynamic>[];
  return raw
      .map((dynamic item) => item.toString())
      .where((String action) => action.isNotEmpty)
      .toList();
}

/// 异步确认操作的展示标签。
String asyncConfirmationActionLabel(
  String action,
  Map<String, dynamic> payload,
) {
  final String status = payload["status"]?.toString() ?? "";
  switch (action) {
    case "continue_processing":
      return "继续处理";
    case "retry":
      return "失败重试";
    case "confirm":
      return status == "awaiting_confirmation" ? "取消" : "确认";
    default:
      return action;
  }
}

/// 是否为主要异步确认操作（继续处理 / 失败重试）。
bool isPrimaryAsyncConfirmationAction(String action) {
  return action == "continue_processing" || action == "retry";
}

/// 移动端简报摘要文本。
String buildMobileBriefingSummary(Map<String, dynamic> briefing) {
  final List<String> parts = <String>[];
  final Object? weather = briefing["weather"];
  if (weather is Map) {
    final String condition = weather["condition"]?.toString() ?? "";
    final Object? temp = weather["temperature"];
    if (condition.isNotEmpty || temp != null) {
      parts.add(
        [
          if (condition.isNotEmpty) condition,
          if (temp != null) "${temp.toString()}°C",
        ].join(" "),
      );
    }
  }
  final Object? schedule = briefing["todaySchedule"];
  if (schedule is List && schedule.isNotEmpty) {
    final Object? first = schedule.first;
    if (first is Map) {
      final String title = first["title"]?.toString() ?? "";
      final String time = first["time"]?.toString() ?? "";
      if (title.isNotEmpty) {
        parts.add(time.isEmpty ? title : "$time $title");
      }
    }
  }
  final Object? notes = briefing["pendingNotes"];
  if (notes is List && notes.isNotEmpty) {
    parts.add("还有 ${notes.length} 条待办提醒");
  }
  return parts.isEmpty ? "点击查看今天的简报内容" : parts.join(" · ");
}

/// 桌面端简报摘要文本（多行）。
String buildDesktopBriefingSummary(Map<String, dynamic> briefing) {
  final List<String> lines = <String>[];
  final String greeting = briefing["agentGreeting"]?.toString() ??
      briefing["greeting"]?.toString() ??
      "";
  if (greeting.isNotEmpty) {
    lines.add(greeting);
  }
  final Object? weather = briefing["weather"];
  if (weather is Map) {
    final String condition = weather["condition"]?.toString() ?? "";
    final String temperature = weather["temperature"]?.toString() ?? "";
    final String description = weather["description"]?.toString() ?? "";
    final String weatherLine = [
      condition,
      temperature.isEmpty ? "" : "$temperature°C",
      description
    ].where((String item) => item.trim().isNotEmpty).join(" · ");
    if (weatherLine.isNotEmpty) {
      lines.add("天气：$weatherLine");
    }
  }
  final Object? outfit = briefing["outfitTip"];
  if (outfit is Map) {
    final String suggestion = outfit["suggestion"]?.toString() ?? "";
    if (suggestion.isNotEmpty) {
      lines.add("穿衣：$suggestion");
    }
  }
  final Object? schedule = briefing["todaySchedule"];
  if (schedule is List && schedule.isNotEmpty) {
    final List<String> top = <String>[];
    for (final Object? item in schedule.take(3)) {
      if (item is Map) {
        final String time = item["time"]?.toString() ?? "";
        final String title = item["title"]?.toString() ?? "";
        if (title.isNotEmpty) {
          top.add(time.isEmpty ? title : "$time $title");
        }
      }
    }
    if (top.isNotEmpty) {
      lines.add("安排：${top.join("；")}");
    }
  }
  final Object? notes = briefing["pendingNotes"];
  if (notes is List && notes.isNotEmpty) {
    final List<String> top = <String>[];
    for (final Object? item in notes.take(3)) {
      if (item is Map) {
        final String title = item["title"]?.toString() ?? "";
        if (title.isNotEmpty) top.add(title);
      } else if (item != null && item.toString().trim().isNotEmpty) {
        top.add(item.toString());
      }
    }
    if (top.isNotEmpty) {
      lines.add("待办：${top.join("；")}");
    }
  }
  return lines.isEmpty ? "今天的简报已经准备好了。" : lines.join("\n");
}
