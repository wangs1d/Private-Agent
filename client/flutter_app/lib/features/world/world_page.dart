import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "../../core/theme/app_theme.dart";
import "social_feed_page.dart";
import "shop_page.dart";
import "world_hub_page.dart";

/// 世界模块入口：嵌套路由，各场景独立页面。
class WorldPage extends StatelessWidget {
  const WorldPage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  Widget build(BuildContext context) {
    return Navigator(
      initialRoute: "/",
      onGenerateRoute: (RouteSettings settings) {
        final String name = settings.name ?? "/";
        late final Widget child;
        switch (name) {
          case "/":
            child = MainPanel(
              child: WorldHubPage(sessionId: sessionId, api: api),
            );
            break;
          case "/shop":
            child = ShopPage(sessionId: sessionId, api: api);
            break;
          case "/social":
            child = SocialFeedPage(sessionId: sessionId, api: api, ws: ws);
            break;
          default:
            child = MainPanel(
              child: WorldHubPage(sessionId: sessionId, api: api),
            );
        }
        return MaterialPageRoute<void>(
          settings: settings,
          builder: (BuildContext context) => child,
        );
      },
    );
  }
}
