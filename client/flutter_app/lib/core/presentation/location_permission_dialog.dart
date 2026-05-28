import "package:flutter/material.dart";

import "../theme/app_theme.dart";

/// 简洁的定位权限弹窗：询问用户是否允许 Agent 获取位置信息。
Future<bool?> showLocationPermissionDialog({
  required BuildContext context,
}) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => const _LocationPermissionDialogBody(),
  );
}

class _LocationPermissionDialogBody extends StatefulWidget {
  const _LocationPermissionDialogBody();

  @override
  State<_LocationPermissionDialogBody> createState() =>
      _LocationPermissionDialogBodyState();
}

class _LocationPermissionDialogBodyState
    extends State<_LocationPermissionDialogBody> {
  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppPalette.locationDialogBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppPalette.locationDialogBorder),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 400),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Text(
                "定位权限",
                style: TextStyle(
                  color: AppPalette.locationDialogTitle,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                "是否允许 Agent 获取您的位置信息？",
                style: TextStyle(
                  color: AppPalette.locationDialogBody.withValues(alpha: 0.92),
                  fontSize: 15,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    style: TextButton.styleFrom(
                      foregroundColor: AppPalette.locationDialogMuted,
                    ),
                    child: const Text("暂不允许"),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppPalette.locationDialogButtonBg,
                      foregroundColor: AppPalette.locationDialogButtonFg,
                    ),
                    child: const Text("允许"),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
