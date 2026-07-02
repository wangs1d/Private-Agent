#ifndef RUNNER_TRANSLATE_OVERLAY_WINDOW_H_
#define RUNNER_TRANSLATE_OVERLAY_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

class TranslateOverlayWindow {
 public:
  struct Card {
    std::string card_id;
    std::string source_text;
    std::string target_text;
    std::string lang_label;
    std::string mode;
    int64_t timestamp_ms = 0;
    bool show_source = true;
  };

  enum class EventType {
    kCloseClicked,
    kClearClicked,
    kLangChanged,
    kFontChanged,
    kSubtitleChanged,
  };
  using EventCallback = std::function<void(EventType type, const std::string& payload)>;

  TranslateOverlayWindow();
  ~TranslateOverlayWindow();

  TranslateOverlayWindow(const TranslateOverlayWindow&) = delete;
  TranslateOverlayWindow& operator=(const TranslateOverlayWindow&) = delete;

  bool Create();
  void Destroy();

  void Show();
  void Hide();
  bool IsVisible() const;
  bool IsCreated() const { return window_handle_ != nullptr; }

  void SetOnTop(bool on_top);
  bool IsOnTop() const { return on_top_; }

  void SetBounds(int x, int y, int width, int height);
  RECT GetBounds() const;

  void SetTargetLanguage(const std::string& lang_code, const std::string& lang_label);
  std::string GetTargetLanguageCode() const { return target_lang_code_; }

  void SetDisplayFont(const std::string& font_name);
  std::string GetDisplayFont() const { return font_name_; }

  void SetSubtitleMode(bool on);
  bool GetSubtitleMode() const { return subtitle_on_; }

  void SetCards(std::vector<Card> cards);
  void AppendCard(const Card& card);
  void UpdateCard(const Card& card);
  void ClearCards();
  void SetLoading(const std::string& card_id, const std::string& message);
  void ClearLoading(const std::string& card_id);

  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_TranslateOverlay_Window";
  static constexpr int kTitleBarHeight = 40;
  static constexpr int kMinWidth = 280;
  static constexpr int kMinHeight = 200;
  static constexpr int kDefaultWidth = 320;
  static constexpr int kDefaultHeight = 280;
  static constexpr int kCornerRadius = 12;

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  static void EnsureClassRegistered();

  void LayoutChildren();
  void Paint(HWND hwnd, HDC hdc);
  void EnsureButtons();
  void ApplyWindowRgn();
  std::wstring Utf8ToWide(const std::string& s) const;
  std::string WideToUtf8(const std::wstring& w) const;

  void FireEvent(EventType type, const std::string& payload = "");

  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
                       COLORREF fill, COLORREF border);
  void DrawUiText(HDC hdc, const RECT& rc, const std::wstring& text,
                  HFONT font, COLORREF color,
                  UINT flags = DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

  HWND window_handle_ = nullptr;

  HWND btn_close_ = nullptr;
  HWND btn_clear_ = nullptr;
  HWND btn_lang_ = nullptr;
  HWND btn_subtitle_ = nullptr;
  HFONT font_ui_ = nullptr;
  HFONT font_title_ = nullptr;

  bool on_top_ = true;
  std::string target_lang_code_ = "zh";
  std::string target_lang_label_ = "中文";
  std::string font_name_ = "Microsoft YaHei UI";
  bool subtitle_on_ = true;
  std::vector<Card> cards_;
  std::vector<std::pair<std::string, std::string>> loading_;

  EventCallback event_callback_;
};

#endif  // RUNNER_TRANSLATE_OVERLAY_WINDOW_H_
