import "package:flutter/material.dart";

String agentAvatarAssetPath(String? preset) {
  switch (preset) {
    case "ember":
      return "assets/agent_avatars/ember.png";
    case "tide":
      return "assets/agent_avatars/tide.png";
    case "eclipse":
      return "assets/agent_avatars/eclipse.png";
    case "neon":
      return "assets/agent_avatars/neon.png";
    case "mist":
      return "assets/agent_avatars/mist.png";
    case "dawn":
    default:
      return "assets/agent_avatars/dawn.png";
  }
}

class AgentAvatarPalette {
  const AgentAvatarPalette(this.colors);

  final List<Color> colors;

  static AgentAvatarPalette fromPreset(String? preset) {
    switch (preset) {
      case "ember":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFFFA24B),
          Color(0xFFFF5A36),
          Color(0xFFC12A2A),
        ]);
      case "tide":
        return const AgentAvatarPalette(<Color>[
          Color(0xFF62D6FF),
          Color(0xFF118AB2),
          Color(0xFF124E78),
        ]);
      case "eclipse":
        return const AgentAvatarPalette(<Color>[
          Color(0xFF8C7DFF),
          Color(0xFF473BF0),
          Color(0xFF171738),
        ]);
      case "neon":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFB8FF52),
          Color(0xFF00C853),
          Color(0xFF00796B),
        ]);
      case "mist":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFB0BEC5),
          Color(0xFF78909C),
          Color(0xFF455A64),
        ]);
      case "dawn":
      default:
        return const AgentAvatarPalette(<Color>[
          Color(0xFF3DA4FF),
          Color(0xFF0D6EFD),
          Color(0xFF123A9E),
        ]);
    }
  }
}
