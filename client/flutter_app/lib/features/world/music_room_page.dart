import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

const String _kWsMusicSnapshot = "world.music.snapshot";

/// 音乐房间：HTTP 创建房间 + WebSocket `world.music.snapshot` 实时同步播放状态。
class MusicRoomPage extends StatefulWidget {
  const MusicRoomPage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<MusicRoomPage> createState() => _MusicRoomPageState();
}

class _MusicRoomPageState extends State<MusicRoomPage> {
  bool _loading = true;
  String? _error;
  String? _roomId;
  bool _busy = false;

  // 当前播放
  String? _trackId;
  String _trackTitle = "";
  String _trackArtist = "";
  double _positionSec = 0;
  double _durationSec = 0;
  bool _isPlaying = false;

  List<Map<String, dynamic>> _playlist = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _participants = <Map<String, dynamic>>[];

  StreamSubscription<Map<String, dynamic>>? _musicSub;

  @override
  void initState() {
    super.initState();
    _musicSub = widget.ws.events.listen(_onMusicWs);
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    _musicSub?.cancel();
    final String? rid = _roomId;
    if (rid != null && rid.isNotEmpty) {
      widget.ws.sendEvent("world.music.unsubscribe", <String, dynamic>{"roomId": rid});
      unawaited(widget.api.leaveMusicRoom(rid, widget.sessionId).catchError((_) => <String, dynamic>{}));
    }
    super.dispose();
  }

  void _onMusicWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      final String? rid = _roomId;
      if (rid != null && rid.isNotEmpty) {
        widget.ws.sendEvent("world.music.subscribe", <String, dynamic>{"roomId": rid});
      }
      return;
    }
    if (type != _kWsMusicSnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    _applySnapshot(payload.cast<String, dynamic>());
  }

  void _applySnapshot(Map<String, dynamic> p) {
    final Object? current = p["currentTrack"];
    String? trackId;
    String title = "";
    String artist = "";
    double duration = 0;
    double position = 0;
    if (current is Map) {
      final Map<String, dynamic> c = current.cast<String, dynamic>();
      trackId = c["id"]?.toString();
      title = c["title"]?.toString() ?? "";
      artist = c["artist"]?.toString() ?? "";
      duration = (c["durationSec"] as num?)?.toDouble() ?? 0;
      position = (c["positionSec"] as num?)?.toDouble() ?? 0;
    }
    final List<Map<String, dynamic>> playlist = <Map<String, dynamic>>[
      for (final Object? x in (p["playlist"] as List<dynamic>?) ?? <dynamic>[])
        if (x is Map) x.cast<String, dynamic>(),
    ];
    final List<Map<String, dynamic>> participants = <Map<String, dynamic>>[
      for (final Object? x in (p["participants"] as List<dynamic>?) ?? <dynamic>[])
        if (x is Map) x.cast<String, dynamic>(),
    ];
    if (!mounted) return;
    setState(() {
      _trackId = trackId;
      _trackTitle = title;
      _trackArtist = artist;
      _durationSec = duration;
      _positionSec = position;
      _isPlaying = p["isPlaying"] == true;
      _playlist = playlist;
      _participants = participants;
      _loading = false;
      _error = null;
    });
  }

  Future<void> _bootstrap() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> r = await widget.api.createMusicRoom(widget.sessionId);
      if (!mounted) return;
      if (r["ok"] != true) {
        setState(() {
          _loading = false;
          _error = r.toString();
        });
        return;
      }
      final String? rid = r["roomId"]?.toString();
      if (rid == null || rid.isEmpty) {
        setState(() {
          _loading = false;
          _error = "未返回 roomId";
        });
        return;
      }
      _roomId = rid;
      widget.ws.sendEvent("world.music.subscribe", <String, dynamic>{"roomId": rid});
      final Object? state = r["state"];
      if (state is Map) {
        _applySnapshot(state.cast<String, dynamic>());
      } else {
        // 拉一次服务端状态兜底
        unawaited(_refresh());
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _refresh() async {
    final String? rid = _roomId;
    if (rid == null || rid.isEmpty) return;
    try {
      final Map<String, dynamic> r = await widget.api.getMusicState(rid, widget.sessionId);
      if (!mounted) return;
      if (r["ok"] != true) {
        setState(() => _loading = false);
        return;
      }
      final Object? state = r["state"];
      if (state is Map) {
        _applySnapshot(state.cast<String, dynamic>());
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _guard(Future<Map<String, dynamic>> Function() op, {String? label}) async {
    if (_busy) return;
    final String? rid = _roomId;
    if (rid == null || rid.isEmpty) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await op();
      if (!mounted) return;
      if (r["ok"] != true && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(label != null ? "$label失败：$r" : "操作失败：$r")),
        );
      }
      final Object? state = r["state"];
      if (state is Map) _applySnapshot(state.cast<String, dynamic>());
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("操作异常：$e")));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _onPlay() => _guard(
        () => widget.api.musicPlay(_roomId!, widget.sessionId),
        label: "播放",
      );

  Future<void> _onPause() => _guard(
        () => widget.api.musicPause(_roomId!, widget.sessionId),
        label: "暂停",
      );

  Future<void> _onNext() => _guard(
        () => widget.api.musicNext(_roomId!, widget.sessionId),
        label: "下一首",
      );

  Future<void> _onPlayTrack(String trackId) => _guard(
        () => widget.api.musicPlay(_roomId!, widget.sessionId, trackId),
        label: "切换曲目",
      );

  static String _fmtTime(double sec) {
    if (sec.isNaN || sec.isInfinite || sec < 0) sec = 0;
    final int total = sec.round();
    final int m = total ~/ 60;
    final int s = total % 60;
    return "${m.toString().padLeft(2, "0")}:${s.toString().padLeft(2, "0")}";
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text("一起听音乐"),
        actions: <Widget>[
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _bootstrap, child: const Text("重试")),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: <Widget>[
                      _NowPlayingCard(
                        title: _trackTitle,
                        artist: _trackArtist,
                        positionSec: _positionSec,
                        durationSec: _durationSec,
                        isPlaying: _isPlaying,
                        busy: _busy,
                        onPlay: _onPlay,
                        onPause: _onPause,
                        onNext: _onNext,
                        theme: theme,
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: <Widget>[
                          Icon(Icons.people_outline, size: 18, color: theme.colorScheme.onSurfaceVariant),
                          const SizedBox(width: 6),
                          Text("参与者 ${_participants.length}", style: theme.textTheme.titleMedium),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (_participants.isEmpty)
                        Text("暂无参与者", style: theme.textTheme.bodySmall)
                      else
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: <Widget>[
                            for (final Map<String, dynamic> p in _participants)
                              Chip(
                                avatar: const Icon(Icons.person, size: 18),
                                label: Text(
                                  p["displayName"]?.toString() ??
                                      (p["sessionId"]?.toString() ?? ""),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                visualDensity: VisualDensity.compact,
                              ),
                          ],
                        ),
                      const SizedBox(height: 16),
                      Row(
                        children: <Widget>[
                          Icon(Icons.queue_music, size: 18, color: theme.colorScheme.onSurfaceVariant),
                          const SizedBox(width: 6),
                          Text("播放列表 ${_playlist.length}", style: theme.textTheme.titleMedium),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (_playlist.isEmpty)
                        Text("暂无曲目", style: theme.textTheme.bodySmall)
                      else
                        for (final Map<String, dynamic> t in _playlist)
                          _TrackTile(
                            title: t["title"]?.toString() ?? "",
                            artist: t["artist"]?.toString() ?? "",
                            durationSec: (t["durationSec"] as num?)?.toDouble() ?? 0,
                            current: t["id"]?.toString() == _trackId,
                            onTap: _busy ? null : () {
                              final String id = t["id"]?.toString() ?? "";
                              if (id.isNotEmpty) unawaited(_onPlayTrack(id));
                            },
                          ),
                    ],
                  ),
                ),
    );
  }
}

class _NowPlayingCard extends StatelessWidget {
  const _NowPlayingCard({
    required this.title,
    required this.artist,
    required this.positionSec,
    required this.durationSec,
    required this.isPlaying,
    required this.busy,
    required this.onPlay,
    required this.onPause,
    required this.onNext,
    required this.theme,
  });

  final String title;
  final String artist;
  final double positionSec;
  final double durationSec;
  final bool isPlaying;
  final bool busy;
  final VoidCallback onPlay;
  final VoidCallback onPause;
  final VoidCallback onNext;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    final double dur = durationSec > 0 ? durationSec : 1;
    final double pos = positionSec.clamp(0, dur);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    Icons.music_note,
                    color: theme.colorScheme.onPrimaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        title.isEmpty ? "未在播放" : title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        artist.isEmpty ? "—" : artist,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            LinearProgressIndicator(
              value: dur > 0 ? pos / dur : 0,
              minHeight: 4,
            ),
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                Text(_MusicRoomPageState._fmtTime(pos), style: theme.textTheme.labelSmall),
                Text(_MusicRoomPageState._fmtTime(durationSec), style: theme.textTheme.labelSmall),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                IconButton(
                  tooltip: isPlaying ? "暂停" : "播放",
                  iconSize: 40,
                  onPressed: busy ? null : (isPlaying ? onPause : onPlay),
                  icon: Icon(isPlaying ? Icons.pause_circle_filled : Icons.play_circle_fill),
                ),
                const SizedBox(width: 24),
                IconButton(
                  tooltip: "下一首",
                  iconSize: 36,
                  onPressed: busy ? null : onNext,
                  icon: const Icon(Icons.skip_next),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _TrackTile extends StatelessWidget {
  const _TrackTile({
    required this.title,
    required this.artist,
    required this.durationSec,
    required this.current,
    required this.onTap,
  });

  final String title;
  final String artist;
  final double durationSec;
  final bool current;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ListTile(
      leading: Icon(
        current ? Icons.graphic_eq : Icons.audiotrack,
        color: current ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant,
      ),
      title: Text(
        title.isEmpty ? "未知曲目" : title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: current ? theme.textTheme.bodyLarge?.copyWith(color: theme.colorScheme.primary) : null,
      ),
      subtitle: Text(
        artist.isEmpty ? "—" : artist,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Text(
        _MusicRoomPageState._fmtTime(durationSec),
        style: theme.textTheme.labelSmall,
      ),
      onTap: onTap,
    );
  }
}
