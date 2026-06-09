import "dart:async";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "friend_chat_page.dart";

/// 邮箱Tab主页面：包含好友列表、好友请求、聊天功能
class MailboxPage extends StatefulWidget {
  const MailboxPage({super.key, required this.api, required this.ws});

  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<MailboxPage> createState() => _MailboxPageState();
}

class _MailboxPageState extends State<MailboxPage> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  StreamSubscription<Map<String, dynamic>>? _wsSub;

  bool _loading = false;
  bool _serverOffline = false;
  List<Map<String, dynamic>> _friends = [];
  List<Map<String, dynamic>> _allRequests = [];

  // 预定义常量
  static const EdgeInsets _cardMargin = EdgeInsets.symmetric(horizontal: 12, vertical: 4);
  static const EdgeInsets _cardPadding = EdgeInsets.all(12);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _wsSub = widget.ws.events.listen(_onWsEvent);
    _loadData();
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    _tabController.dispose();
    super.dispose();
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    // WebSocket 重连成功时自动刷新好友数据
    if (type == "session.init" && _serverOffline) {
      _loadData();
    }
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      await Future.wait([
        _loadFriends(),
        _loadAllRequests(),
      ]);
    } catch (_) {
      // 各子方法已自行处理
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _loadFriends() async {
    try {
      final result = await widget.api.getFriendsList();
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _friends = List<Map<String, dynamic>>.from(result["friends"] ?? []);
          _serverOffline = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_isNetworkError(e)) {
        setState(() => _serverOffline = true);
      }
    }
  }

  Future<void> _loadAllRequests() async {
    try {
      final result = await widget.api.getAllFriendRequests();
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _allRequests = List<Map<String, dynamic>>.from(result["requests"] ?? []);
          _serverOffline = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_isNetworkError(e)) {
        setState(() => _serverOffline = true);
      }
    }
  }

  bool _isNetworkError(Object error) {
    final String msg = error.toString();
    return msg.contains("Failed to fetch") ||
        msg.contains("ClientException") ||
        msg.contains("SocketException") ||
        msg.contains("Connection refused");
  }

  Future<void> _acceptRequest(String requestId) async {
    try {
      final result = await widget.api.respondToFriendRequest(requestId, true);
      if (result["ok"] == true) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已接受好友请求")),
          );
          await _loadData();
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(result["message"] ?? "操作失败")),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("操作失败: $e")),
        );
      }
    }
  }

  Future<void> _rejectRequest(String requestId) async {
    try {
      final result = await widget.api.respondToFriendRequest(requestId, false);
      if (result["ok"] == true) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已拒绝好友请求")),
          );
          await _loadData();
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("操作失败: $e")),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      children: [
        // TabBar
        TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: "好友"),
            Tab(text: "新朋友"),
          ],
        ),
        // TabBarView
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              // 好友列表
              _buildFriendsList(theme),
              // 新朋友（所有请求）
              _buildNewFriendsList(theme),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildFriendsList(ThemeData theme) {
    if (_loading && _friends.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_serverOffline) {
      return _buildOfflineHint(theme);
    }

    if (_friends.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              "暂无好友",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              "点击右上角 + 添加好友",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.builder(
        itemCount: _friends.length,
        itemBuilder: (context, index) {
          final friend = _friends[index];
          final displayName = friend["displayName"] as String? ?? friend["friendActorId"] as String;
          final email = friend["email"] as String?;

          return ListTile(
            leading: CircleAvatar(
              backgroundColor: theme.colorScheme.primaryContainer,
              child: Text(
                displayName.isNotEmpty ? displayName[0].toUpperCase() : "?",
                style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
              ),
            ),
            title: Text(displayName),
            subtitle: email != null && email.isNotEmpty
                ? Text(email, style: theme.textTheme.bodySmall)
                : null,
            trailing: IconButton(
              icon: const Icon(Icons.chat_bubble_outline),
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => FriendChatPage(
                      api: widget.api,
                      friendActorId: friend["friendActorId"] as String,
                      friendName: displayName,
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }

  Widget _buildNewFriendsList(ThemeData theme) {
    if (_loading && _allRequests.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_serverOffline) {
      return _buildOfflineHint(theme);
    }

    if (_allRequests.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              "暂无新朋友",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              "点击右上角 + 添加好友",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadAllRequests,
      child: ListView.builder(
        itemCount: _allRequests.length,
        itemBuilder: (context, index) {
          final request = _allRequests[index];
          final fromActorId = request["fromActorId"] as String;
          final toActorId = request["toActorId"] as String;
          final status = request["status"] as String?;
          final message = request["message"] as String?;
          final createdAt = request["createdAt"] as String?;
          
          // 判断是收到的还是发出的请求
          final bool isIncoming = fromActorId != ApiConfig.effectiveActorId;
          final String otherActorId = isIncoming ? fromActorId : toActorId;

          return Card(
            margin: _cardMargin,
            child: Padding(
              padding: _cardPadding,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        backgroundColor: isIncoming 
                            ? theme.colorScheme.secondaryContainer
                            : theme.colorScheme.tertiaryContainer,
                        child: Text(
                          otherActorId.isNotEmpty ? otherActorId[0].toUpperCase() : "?",
                          style: TextStyle(
                            color: isIncoming 
                                ? theme.colorScheme.onSecondaryContainer
                                : theme.colorScheme.onTertiaryContainer,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    otherActorId,
                                    style: theme.textTheme.titleSmall,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: isIncoming
                                        ? theme.colorScheme.secondaryContainer
                                        : theme.colorScheme.tertiaryContainer,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    isIncoming ? "收到" : "发出",
                                    style: theme.textTheme.bodySmall?.copyWith(
                                      fontSize: 10,
                                      color: isIncoming
                                          ? theme.colorScheme.onSecondaryContainer
                                          : theme.colorScheme.onTertiaryContainer,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            if (createdAt != null)
                              Text(
                                DateTime.parse(createdAt).toString().substring(0, 19),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  if (message != null && message.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        message,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ],
                  // 状态显示
                  if (!isIncoming || status != "pending") ...[
                    const SizedBox(height: 8),
                    _buildStatusChip(status, theme),
                  ],
                  // 操作按钮（仅对收到的待处理请求显示）
                  if (isIncoming && status == "pending") ...[
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: () => _rejectRequest(request["requestId"] as String),
                          child: const Text("拒绝"),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () => _acceptRequest(request["requestId"] as String),
                          child: const Text("接受"),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildOfflineHint(ThemeData theme) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.cloud_off, size: 64, color: theme.colorScheme.error),
          const SizedBox(height: 16),
          Text(
            "无法连接服务器",
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            "请先启动 server：npm run dev:server",
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: _loadData,
            child: const Text("重试"),
          ),
        ],
      ),
    );
  }

  Widget _buildStatusChip(String? status, ThemeData theme) {
    String statusText = "";
    Color statusColor = theme.colorScheme.onSurfaceVariant;
    Color containerColor = theme.colorScheme.surfaceContainerHighest;
    
    switch (status) {
      case "pending":
        statusText = "等待对方回应";
        statusColor = theme.colorScheme.primary;
        containerColor = theme.colorScheme.primaryContainer;
        break;
      case "accepted":
        statusText = "已接受";
        statusColor = theme.colorScheme.tertiary;
        containerColor = theme.colorScheme.tertiaryContainer;
        break;
      case "rejected":
        statusText = "已拒绝";
        statusColor = theme.colorScheme.error;
        containerColor = theme.colorScheme.errorContainer;
        break;
      case "cancelled":
        statusText = "已取消";
        statusColor = theme.colorScheme.onSurfaceVariant;
        containerColor = theme.colorScheme.surfaceContainerHighest;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: containerColor,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        statusText,
        style: theme.textTheme.bodySmall?.copyWith(
          color: statusColor,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}
