import "dart:async";
import "dart:convert" show jsonDecode;
import "dart:typed_data";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";

/// 图库页：常用工具「图库」入口的落地页。
///
/// 对接服务端 `/picture/*` 路由（@private-ai-agent/picture 套件）：
/// - 网格浏览已入库照片（缩略图分页加载）
/// - 本地图片上传入库
/// - 点开大图后可删除照片（连源文件与缩略图一并移除）
class GalleryPage extends StatefulWidget {
  const GalleryPage({super.key, this.embedded = false});

  /// 嵌入右侧双面板时为 true：隐藏自带 AppBar（面板顶栏已有"图库"标题），
  /// 上传按钮改为面板内右上角图标。
  final bool embedded;

  @override
  State<GalleryPage> createState() => _GalleryPageState();
}

class _Photo {
  _Photo.fromJson(Map<String, dynamic> json)
      : id = json["id"] as String,
        fileName = (json["fileName"] as String?) ?? "",
        tags = ((json["tags"] as List<dynamic>?) ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        thumbnailUrl = (json["thumbnailUrl"] as String?) ?? "",
        imageUrl = (json["imageUrl"] as String?) ?? "";

  final String id;
  final String fileName;
  final List<String> tags;
  final String thumbnailUrl;
  final String imageUrl;
}

class _GalleryPageState extends State<GalleryPage> {
  final ScrollController _scrollController = ScrollController();
  final List<_Photo> _photos = <_Photo>[];
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasMore = true;
  int _page = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final double position = _scrollController.position.maxScrollExtent -
        _scrollController.position.pixels;
    if (position < 400 && !_loadingMore && _hasMore && !_loading) {
      _loadMore();
    }
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    return Uri.parse("${ApiConfig.httpBase}$path")
        .replace(queryParameters: query);
  }

  Map<String, dynamic> _decodeBody(http.Response response) {
    final dynamic decoded = jsonDecode(response.body);
    return decoded as Map<String, dynamic>;
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final http.Response response = await http
          .get(_uri("/picture/assets", <String, String>{
        "page": "1",
        "pageSize": "30",
      }))
          .timeout(const Duration(seconds: 10));
      final Map<String, dynamic> body = _decodeBody(response);
      if (body["ok"] != true) {
        throw StateError((body["error"] as String?) ?? "加载失败");
      }
      final List<dynamic> photos = (body["photos"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _photos
          ..clear()
          ..addAll(photos.map((dynamic item) => _Photo.fromJson(item as Map<String, dynamic>)));
        _page = 1;
        _hasMore = _photos.length < ((body["total"] as num?)?.toInt() ?? 0);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = "图库加载失败：$e\n请确认服务端已启动并已上传/生成过图片";
      });
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() => _loadingMore = true);
    try {
      final http.Response response = await http
          .get(_uri("/picture/assets", <String, String>{
        "page": "${_page + 1}",
        "pageSize": "30",
      }))
          .timeout(const Duration(seconds: 10));
      final Map<String, dynamic> body = _decodeBody(response);
      final List<dynamic> photos = (body["photos"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _photos.addAll(photos.map((dynamic item) => _Photo.fromJson(item as Map<String, dynamic>)));
        _page += 1;
        _hasMore = photos.isNotEmpty;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  Future<void> _uploadImages() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      type: FileType.image,
      allowMultiple: true,
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;
    int success = 0;
    for (final PlatformFile file in result.files) {
      try {
        final http.MultipartRequest request = http.MultipartRequest(
          "POST",
          _uri("/picture/assets"),
        );
        final Uint8List? bytes = file.bytes;
        if (bytes != null) {
          request.files.add(
            http.MultipartFile.fromBytes("file", bytes, filename: file.name),
          );
        } else if (file.path != null) {
          request.files.add(
            await http.MultipartFile.fromPath("file", file.path!, filename: file.name),
          );
        } else {
          continue;
        }
        final http.StreamedResponse streamed =
            await request.send().timeout(const Duration(seconds: 60));
        if (streamed.statusCode == 200) {
          success += 1;
        }
      } catch (_) {
        // 单张失败不影响其余
      }
    }
    messenger.showSnackBar(SnackBar(content: Text("已上传 $success/${result.files.length} 张")));
    await _refresh();
  }

  Future<void> _deletePhoto(_Photo photo) async {
    final NavigatorState navigator = Navigator.of(context, rootNavigator: true);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final String displayName =
        photo.fileName.isEmpty ? "未命名照片" : photo.fileName;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("删除照片"),
        content: Text("确定删除「$displayName」吗？删除后不可恢复。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final http.Response response = await http
          .delete(_uri("/picture/assets/${photo.id}"))
          .timeout(const Duration(seconds: 15));
      final Map<String, dynamic> body = _decodeBody(response);
      if (response.statusCode == 200 && body["ok"] == true) {
        messenger.showSnackBar(
          SnackBar(content: Text("已删除「$displayName」")),
        );
        navigator.pop(); // 关闭大图/详情
        await _refresh();
      } else {
        messenger.showSnackBar(
          SnackBar(
            content:
                Text("删除失败：${body["reason"] ?? body["error"] ?? response.statusCode}"),
          ),
        );
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("删除失败：$e")));
    }
  }

  void _openPhotoDetail(_Photo photo) {
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (BuildContext sheetContext) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.92,
          builder: (BuildContext context, ScrollController scrollController) {
            return Column(
              children: <Widget>[
                Expanded(
                  child: InteractiveViewer(
                    maxScale: 4,
                    child: Center(
                      child: Image.network(
                        "${ApiConfig.httpBase}${photo.imageUrl}",
                        fit: BoxFit.contain,
                        errorBuilder: (_, Object error, StackTrace? stack) =>
                            const Text("图片加载失败"),
                      ),
                    ),
                  ),
                ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                    child: SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor:
                              Theme.of(context).colorScheme.error,
                        ),
                        onPressed: () => _deletePhoto(photo),
                        icon: const Icon(Icons.delete_outline),
                        label: const Text("删除照片"),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (widget.embedded) {
      return Scaffold(
        floatingActionButton: FloatingActionButton.extended(
          onPressed: _uploadImages,
          icon: const Icon(Icons.upload_outlined),
          label: const Text("上传"),
        ),
        body: _buildBody(cs),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text("图库")),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _uploadImages,
        icon: const Icon(Icons.upload_outlined),
        label: const Text("上传"),
      ),
      body: _buildBody(cs),
    );
  }

  Widget _buildBody(ColorScheme cs) {
    if (_loading && _photos.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _photos.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.photo_library_outlined, size: 48, color: cs.outline),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton.tonal(onPressed: _refresh, child: const Text("重试")),
            ],
          ),
        ),
      );
    }
    if (_photos.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.photo_outlined, size: 48, color: cs.outline),
            const SizedBox(height: 12),
            const Text("图库还是空的，点右下角上传照片"),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: GridView.builder(
        controller: _scrollController,
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 96),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          mainAxisSpacing: 4,
          crossAxisSpacing: 4,
        ),
        itemCount: _photos.length + (_hasMore ? 1 : 0),
        itemBuilder: (BuildContext context, int index) {
          if (index >= _photos.length) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          final _Photo photo = _photos[index];
          return _PhotoTile(
            photo: photo,
            httpBase: ApiConfig.httpBase,
            onTap: () => _openPhotoDetail(photo),
          );
        },
      ),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({
    required this.photo,
    required this.httpBase,
    required this.onTap,
  });

  final _Photo photo;
  final String httpBase;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          Image.network(
            "$httpBase${photo.thumbnailUrl}",
            fit: BoxFit.cover,
            errorBuilder: (_, Object error, StackTrace? stack) => const ColoredBox(
              color: Color(0x22800000),
              child: Center(child: Icon(Icons.broken_image_outlined)),
            ),
          ),
        ],
      ),
    );
  }
}
