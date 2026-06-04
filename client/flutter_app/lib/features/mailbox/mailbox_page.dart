import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";
import "friend_chat_page.dart";

/// 邮箱Tab主页面：包含好友列表、好友请求、聊天功能
class MailboxPage extends StatefulWidget {
  const MailboxPage({super.key, required this.api});

  final WorldApiClient api;

  @override
  State<MailboxPage> createState() => _MailboxPageState();
}

class _MailboxPageState extends State<MailboxPage> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  
  bool _loading = false;
  List<Map<String, dynamic>> _friends = [];
  List<Map<String, dynamic>> _allRequests = [];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      await Future.wait([
        _loadFriends(),
        _loadAllRequests(),
      ]);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("加载失败: $e")),
        );
      }
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
        });
      }
    } catch (e) {
      if (!mounted) return;
      final String hint = _networkErrorHint(e);
      debugPrint("加载好友列表失败: $e");
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(hint)),
      );
    }
  }

  Future<void> _loadAllRequests() async {
    try {
      final result = await widget.api.getAllFriendRequests();
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _allRequests = List<Map<String, dynamic>>.from(result["requests"] ?? []);
        });
      }
    } catch (e) {
      if (!mounted) return;
      final String hint = _networkErrorHint(e);
      debugPrint("加载好友请求失败: $e");
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(hint)),
      );
    }
  }

  String _networkErrorHint(Object error) {
    final String msg = error.toString();
    if (msg.contains("Failed to fetch") ||
        msg.contains("ClientException") ||
        msg.contains("SocketException") ||
        msg.contains("Connection refused")) {
      return "无法连接主服务（${ApiConfig.httpBase}），请先启动 server：npm run dev:server";
    }
    return "加载失败: $error";
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

  void _showAddFriendDialog() {
    final TextEditingController controller = TextEditingController();
    final TextEditingController messageController = TextEditingController();

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text("添加好友"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: controller,
              decoration: const InputDecoration(
                labelText: "Agent ID",
                hintText: "输入对方的 Agent ID",
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: messageController,
              decoration: const InputDecoration(
                labelText: "验证消息（可选）",
                hintText: "介绍一下自己吧",
              ),
              maxLines: 2,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text("取消"),
          ),
          FilledButton(
            onPressed: () async {
              final toActorId = controller.text.trim();
              if (toActorId.isEmpty) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text("请输入 Agent ID")),
                );
                return;
              }

              Navigator.pop(context);

              try {
                final result = await widget.api.sendFriendRequest(
                  toActorId,
                  message: messageController.text.trim().isEmpty
                      ? null
                      : messageController.text.trim(),
                );

                if (mounted) {
                  if (result["ok"] == true) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text("好友请求已发送")),
                    );
                    await _loadAllRequests();
                  } else {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(result["message"] ?? "发送失败")),
                    );
                  }
                }
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text("发送失败: $e")),
                  );
                }
              }
            },
            child: const Text("发送"),
          ),
        ],
      ),
    );
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
          final addedAt = friend["addedAt"] as String?;

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
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Padding(
              padding: const EdgeInsets.all(12),
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
                                Text(
                                  otherActorId,
                                  style: theme.textTheme.titleSmall,
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
