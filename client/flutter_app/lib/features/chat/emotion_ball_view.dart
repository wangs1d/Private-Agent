// EmotionBallView 条件导出入口。
//
// - 原生平台(io):`emotion_ball_view_io.dart` —— Windows WebView2 内嵌
//   emotion-ball 小球动画;非 Windows 原生平台在运行时降级为占位实现。
// - Web(html):`emotion_ball_view_stub.dart` 占位。
export "emotion_ball_view_io.dart" //
    if (dart.library.html) "emotion_ball_view_stub.dart";
