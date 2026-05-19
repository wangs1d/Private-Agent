import "package:flutter/material.dart";
import "dart:async";

import "../../core/services/multimodal_recognition_service.dart";
import "../chat/voiceprint_registration_page.dart";
import "../chat/face_registration_page.dart";

class BiometricRegistrationPage extends StatefulWidget {
  const BiometricRegistrationPage({
    super.key,
    required this.userId,
    required this.onComplete,
  });

  final String userId;
  final VoidCallback onComplete;

  @override
  State<BiometricRegistrationPage> createState() => _BiometricRegistrationPageState();
}

class _BiometricRegistrationPageState extends State<BiometricRegistrationPage> {
  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  
  // 注册状态
  bool _voiceRegistered = false;
  bool _faceRegistered = false;
  String _statusText = '欢迎使用生物特征注册';
  
  @override
  void initState() {
    super.initState();
    _initializeService();
  }

  Future<void> _initializeService() async {
    await _recognitionService.initialize(userId: widget.userId);
  }



  // ==================== UI ====================
  
  void _showVoiceprintDialog() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => VoiceprintRegistrationPage(
          userId: widget.userId,
          onRegistrationComplete: () {
            Navigator.of(context).pop();
            setState(() {
              _voiceRegistered = true;
              _statusText = '✓ 声纹注册成功';
            });
          },
        ),
      ),
    );
  }

  void _showFaceDialog() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => FaceRegistrationPage(
          userId: widget.userId,
          onRegistrationComplete: () {
            Navigator.of(context).pop();
            setState(() {
              _faceRegistered = true;
              _statusText = '✓ 面部注册成功';
            });
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF2A2A2A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text(
          '增强账户安全',
          style: TextStyle(color: Colors.white),
        ),
      ),
      body: Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 500),
          padding: const EdgeInsets.all(32),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 说明文字
                Text(
                  '您可以选择性地注册以下生物特征（可选）',
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.6),
                    fontSize: 14,
                  ),
                ),
                const SizedBox(height: 24),

                // 声纹识别选项
                _buildOptionCard(
                  title: '声纹识别',
                  subtitle: '通过声音验证身份',
                  icon: Icons.mic,
                  isCompleted: _voiceRegistered,
                  onTap: _showVoiceprintDialog,
                ),
                const SizedBox(height: 16),

                // 面部识别选项
                _buildOptionCard(
                  title: '面部识别',
                  subtitle: '通过面部特征验证身份',
                  icon: Icons.face,
                  isCompleted: _faceRegistered,
                  onTap: _showFaceDialog,
                ),
                const SizedBox(height: 24),

                // 状态提示
                if (_statusText.isNotEmpty)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: _statusText.contains('✓') 
                          ? Colors.green.withOpacity(0.1)
                          : Colors.white.withOpacity(0.05),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: _statusText.contains('✓') 
                            ? Colors.green.withOpacity(0.3)
                            : Colors.white.withOpacity(0.1),
                      ),
                    ),
                    child: Text(
                      _statusText,
                      style: TextStyle(
                        color: _statusText.contains('✓') 
                            ? Colors.green
                            : Colors.white,
                        fontSize: 14,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                
                const SizedBox(height: 32),

                // 按钮区域
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () {
                          widget.onComplete();
                        },
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.white,
                          side: BorderSide(color: Colors.white.withOpacity(0.3)),
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: const Text('稍后设置', style: TextStyle(fontSize: 16)),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: () {
                          widget.onComplete();
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF424242),
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: const Text('完成', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),

                // 直接进入按钮（调试用）
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: () {
                      widget.onComplete();
                    },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.white.withOpacity(0.5),
                      side: BorderSide(color: Colors.white.withOpacity(0.15)),
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: const Text(
                      '直接进入（调试）',
                      style: TextStyle(fontSize: 14),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildOptionCard({
    required String title,
    required String subtitle,
    required IconData icon,
    required bool isCompleted,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.05),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isCompleted 
                ? Colors.green.withOpacity(0.3)
                : Colors.white.withOpacity(0.1),
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.grey.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, color: Colors.grey, size: 24),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: TextStyle(
                      color: Colors.white.withOpacity(0.6),
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            if (isCompleted)
              const Icon(Icons.check_circle, color: Colors.green, size: 20)
            else
              Icon(
                Icons.chevron_right,
                color: Colors.white.withOpacity(0.5),
                size: 20,
              ),
          ],
        ),
      ),
    );
  }
}
