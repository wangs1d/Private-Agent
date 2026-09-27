#include "dynamic_island_window.h"

#include <windowsx.h>

#include <gdiplus.h>
#include <mmsystem.h>
#include <shellapi.h>

#include <thread>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <tuple>

#include "embedded_font.h"

#ifndef USER_DEFAULT_SCREEN_DPI
#define USER_DEFAULT_SCREEN_DPI 96
#endif

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "winmm.lib")

namespace {

// ── GDI+ 进程级初始化 ──
ULONG_PTR g_gdiplus_token = 0;

void EnsureGdiplusIsland() {
  if (g_gdiplus_token != 0) return;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&g_gdiplus_token, &input, nullptr);
}

// Gdiplus::Font(hdc, hfont) 只在构造时读一次 LOGFONT，不接管 HFONT。
// 动画态 60fps 渲染、每帧最多 9 处字体构造——若每次 CreateFontW 都不释放，
// 约 1 分钟就打满进程 GDI 句柄上限（默认 1 万），此后 CreateDIBSection
// 失败、premultiply 循环读空位图直接 0xc0000005。字体组合有限
// （族 × 字号 × 字重 × 删除线），进程级缓存复用，句柄数有界。
HFONT CachedIslandFont(const wchar_t* family, int size, int weight,
                       bool strike) {
  static std::map<std::tuple<std::wstring, int, int, bool>, HFONT> cache;
  const auto key = std::make_tuple(std::wstring(family), size, weight, strike);
  const auto it = cache.find(key);
  if (it != cache.end()) return it->second;
  HFONT font = CreateFontW(size, 0, 0, 0, weight, FALSE, strike ? TRUE : FALSE,
                           FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, family);
  cache[key] = font;
  return font;
}

HFONT MakeIslandFont(int size, int weight, bool strike = false) {
  return CachedIslandFont(IslandFontFamily(), size, weight, strike);
}

// 状态图标专用：Segoe MDL2 Assets 字形不在 MiSans 里，必须独立字族。
HFONT MakeIslandGlyphFont(int size) {
  return CachedIslandFont(L"Segoe MDL2 Assets", size, 400, false);
}

// 字形（Segoe MDL2 Assets）：task/update/schedule/briefing/inbox
const wchar_t* KindGlyph(DynamicIslandWindow::Kind kind) {
  switch (kind) {
    case DynamicIslandWindow::Kind::kTask: return L"\uE9D9";     // Diagnostic
    case DynamicIslandWindow::Kind::kUpdate: return L"\uE74E";   // Download
    case DynamicIslandWindow::Kind::kSchedule: return L"\uE787"; // Calendar
    case DynamicIslandWindow::Kind::kBriefing: return L"\uE8A5"; // Document
    case DynamicIslandWindow::Kind::kInbox: return L"\uE896";    // Mail
  }
  return L"\uE787";
}

// 自绘状态图标（字体字形在 MDL2 里缺失的类别用矢量画，杜绝豆腐块）。
// task：进度圆环（spinning 时旋转）；briefing：文档；inbox：信封。
void DrawTaskIcon(Gdiplus::Graphics& g, float cx, float cy, float r,
                  double phase_s) {
  Gdiplus::Pen pen(Gdiplus::Color(190, 255, 255, 255), 1.6f);
  const float d = r * 2;
  const float start = static_cast<float>(std::fmod(phase_s * 240.0, 360.0));
  Gdiplus::RectF ring(cx - r, cy - r, d, d);
  g.DrawArc(&pen, ring, start, 300);
}

void DrawDocIcon(Gdiplus::Graphics& g, float cx, float cy, float w,
                 float h) {
  Gdiplus::Pen pen(Gdiplus::Color(190, 255, 255, 255), 1.4f);
  Gdiplus::RectF body(cx - w / 2, cy - h / 2, w, h);
  g.DrawRectangle(&pen, body);
  Gdiplus::Pen line_pen(Gdiplus::Color(150, 255, 255, 255), 1.1f);
  for (int i = 1; i <= 2; i++) {
    const float ly = cy - h / 2 + h * i / 3.0f;
    g.DrawLine(&line_pen, cx - w * 0.28f, ly, cx + w * 0.28f, ly);
  }
}

void DrawMailIcon(Gdiplus::Graphics& g, float cx, float cy, float w,
                  float h) {
  Gdiplus::Pen pen(Gdiplus::Color(190, 255, 255, 255), 1.4f);
  Gdiplus::RectF body(cx - w / 2, cy - h / 2, w, h);
  g.DrawRectangle(&pen, body);
  g.DrawLine(&pen, cx - w / 2, cy - h / 2, cx, cy + h * 0.08f);
  g.DrawLine(&pen, cx + w / 2, cy - h / 2, cx, cy + h * 0.08f);
}

const wchar_t* kActionLabels[] = {L"创建日程", L"打开简报", L"静音"};
constexpr int kActionCount = 3;

constexpr double kMorphDurationS = 0.36;

double EaseOutCubic(double t) { return 1.0 - std::pow(1.0 - t, 3.0); }

double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// 轻提醒音（随 attention 动画）：waveOut 现场合成。
// 用户从三候选中选定 C：A4 低钟单音——钟体泛音（1/2/2.92 倍频）、
// 长衰减 tau=0.45、30ms 柔和起音，沉稳不刺耳。振幅 0.15。
// 播放异步收尾：钟声 1.4s，留余量 2.1s 后释放资源。
void PlayAttentionChime() {
  static bool failed = false;
  if (failed) return;
  const int kSampleRate = 44100;
  const int kSamples = static_cast<int>(kSampleRate * 1.4);
  std::vector<short> buf(kSamples);
  for (int i = 0; i < kSamples; i++) {
    const double t = i / static_cast<double>(kSampleRate);
    const double env = std::exp(-t / 0.45) * std::min(t / 0.03, 1.0);
    const double tone = std::sin(6.2831853 * 440.0 * t) +
                        std::sin(6.2831853 * 880.0 * t) * 0.20 +
                        std::sin(6.2831853 * 1284.8 * t) * 0.10;
    buf[i] = static_cast<short>(0.15 * env * tone * 32767.0);
  }
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 1;
  fmt.nSamplesPerSec = kSampleRate;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  HWAVEOUT out = nullptr;
  if (waveOutOpen(&out, WAVE_MAPPER, &fmt, 0, 0, CALLBACK_NULL) !=
      MMSYSERR_NOERROR) {
    failed = true;  // 无可用输出设备：静默降级（动画照常）
    return;
  }
  WAVEHDR* hdr = new WAVEHDR{};
  hdr->lpData = reinterpret_cast<LPSTR>(buf.data());
  hdr->dwBufferLength = static_cast<DWORD>(buf.size() * sizeof(short));
  waveOutPrepareHeader(out, hdr, sizeof(WAVEHDR));
  waveOutWrite(out, hdr, sizeof(WAVEHDR));
  std::thread([out, hdr, b = std::move(buf)]() {
    Sleep(2100);
    waveOutUnprepareHeader(out, hdr, sizeof(WAVEHDR));
    delete hdr;
    waveOutClose(out);
  }).detach();
}

void RoundedPath(Gdiplus::GraphicsPath* path, const Gdiplus::RectF& r,
                 float radius) {
  path->Reset();
  const float d = radius * 2;
  path->AddArc(r.X, r.Y, d, d, 180, 90);
  path->AddArc(r.X + r.Width - d, r.Y, d, d, 270, 90);
  path->AddArc(r.X + r.Width - d, r.Y + r.Height - d, d, d, 0, 90);
  path->AddArc(r.X, r.Y + r.Height - d, d, d, 90, 90);
  path->CloseFigure();
}

}  // namespace

DynamicIslandWindow::DynamicIslandWindow() = default;

DynamicIslandWindow::~DynamicIslandWindow() { Destroy(); }

bool DynamicIslandWindow::IsVisible() const {
  return visible_ && !suppressed_by_fullscreen_;
}

std::wstring DynamicIslandWindow::Utf8ToWide(const std::string& s) const {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

void DynamicIslandWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = DynamicIslandWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_HAND);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool DynamicIslandWindow::Create() {
  EnsureGdiplusIsland();
  if (window_handle_ != nullptr) return true;
  EnsureClassRegistered();
  const DWORD ex_style =
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  window_handle_ = CreateWindowExW(
      ex_style, kClassName, L"", WS_POPUP, 0, 0, S(kWindowW), S(kWindowH),
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (window_handle_ == nullptr) return false;
  const UINT dpi = GetDpiForWindow(window_handle_);
  if (dpi != 0) dpi_scale_ = static_cast<double>(dpi) / USER_DEFAULT_SCREEN_DPI;
  PositionAtTopCenter();
  Render();
  // 心跳计时器随即启动：待机呼吸灯/全屏抑制检查都依赖它。
  // （真实数据版待机不再有 present/Show 调用，若不在此启动则呼吸冻结。）
  StartAnimTimer();
  return true;
}

void DynamicIslandWindow::Destroy() {
  if (window_handle_ == nullptr) return;
  DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void DynamicIslandWindow::PositionAtTopCenter() {
  RECT wa = {};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0)) {
    wa = {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
  }
  const int w = S(kWindowW);
  const int h = S(kWindowH);
  const int x = wa.left + ((wa.right - wa.left) - w) / 2;
  const int y = wa.top;
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, w, h,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

void DynamicIslandWindow::Show() {
  visible_ = true;
  if (window_handle_ == nullptr) {
    Create();
    return;
  }
  if (!suppressed_by_fullscreen_) {
    PositionAtTopCenter();
    ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
  }
  StartAnimTimer();
}

void DynamicIslandWindow::Hide() {
  visible_ = false;
  if (window_handle_ != nullptr) {
    ShowWindow(window_handle_, SW_HIDE);
  }
  StopAnimTimer();
}

void DynamicIslandWindow::SetEntry(const Entry& entry) {
  entry_ = entry;
  has_entry_ = !entry.title.empty();
  if (window_handle_ != nullptr) {
    Render();
    if (has_entry_ && !IsVisible()) Show();
  }
}

void DynamicIslandWindow::ClearEntry() {
  has_entry_ = false;
  entry_ = Entry{};
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetAgenda(std::vector<AgendaItem> items) {
  agenda_ = std::move(items);
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetExpanded(bool expanded) {
  if (expanded_ == expanded) return;
  morph_from_ = morph_;
  expanded_ = expanded;
  if (window_handle_ != nullptr) {
    morph_start_s_ = now_s_;
    StartAnimTimer();
  }
}

void DynamicIslandWindow::StartAttention(const std::string& title,
                                          const std::string& trailing) {
  PlayAttentionChime();
  attention_title_ = Utf8ToWide(title);
  attention_trailing_ = Utf8ToWide(trailing);
  // 展开态来提醒：瞬时收起（不播收缩动画），attention 恒以小胶囊为基准。
  if (expanded_) {
    expanded_ = false;
    morph_ = 0.0;
    morph_from_ = 0.0;
    morph_start_s_ = now_s_ - kMorphDurationS;
  }
  attention_start_s_ = now_s_;
  // 待机态来提醒：注入临时条目让胶囊有内容可显（结束由 Dart 侧收口）。
  if (!has_entry_ && !attention_title_.empty()) {
    Entry e;
    e.id = "attention";
    e.title = title;
    e.trailing = trailing;
    e.kind = Kind::kSchedule;
    entry_ = e;
    has_entry_ = true;
  }
  if (window_handle_ != nullptr) {
    if (!IsVisible()) Show();
    StartAnimTimer();
  }
}

// attention 时间线：放大入(easeOutBack) -> 保持高亮脉冲 -> 缩回。
// 返回当前缩放；attention 未激活/已结束返回 1。
double DynamicIslandWindow::AttentionScale() const {
  if (attention_start_s_ < 0) return 1.0;
  const double t = now_s_ - attention_start_s_;
  if (t < 0) return 1.0;
  if (t < kAttnInS) {
    const double x = t / kAttnInS;
    // easeOutBack：略微过冲再回弹，强调「看这里」
    const double c1 = 1.70158;
    const double c3 = c1 + 1;
    const double e = 1 + c3 * std::pow(x - 1, 3) + c1 * std::pow(x - 1, 2);
    return 1.0 + (kAttentionScale - 1.0) * e;
  }
  if (t < kAttnInS + kAttnHoldS) return kAttentionScale;
  if (t < kAttnInS + kAttnHoldS + kAttnOutS) {
    const double x = (t - kAttnInS - kAttnHoldS) / kAttnOutS;
    return kAttentionScale + (1.0 - kAttentionScale) * EaseOutCubic(x);
  }
  return 1.0;  // 已结束（调用方负责清 attention_start_s_）
}

void DynamicIslandWindow::SetDpiScale(double scale) {
  if (scale <= 0.1 || scale >= 10.0 || scale == dpi_scale_) return;
  dpi_scale_ = scale;
  if (window_handle_ != nullptr) {
    PositionAtTopCenter();
    Render();
  }
}

void DynamicIslandWindow::StartAnimTimer() {
  if (window_handle_ == nullptr || anim_timer_on_) return;
  anim_timer_on_ = true;
  anim_epoch_ms_ = GetTickCount64();
  SetTimer(window_handle_, 1, 16, nullptr);
}

void DynamicIslandWindow::StopAnimTimer() {
  if (!anim_timer_on_) return;
  anim_timer_on_ = false;
  if (window_handle_ != nullptr) KillTimer(window_handle_, 1);
}

void DynamicIslandWindow::UpdateAnimations() {
  const ULONGLONG now = GetTickCount64();
  now_s_ = static_cast<double>(now - anim_epoch_ms_) / 1000.0;
  // 从形变起点值向目标（expanded_）插值；时长走完后精确停在目标，
  // 避免起点过期后 morph 漂移到 1（曾致所有胶囊被画成展开卡尺寸）。
  const double target = expanded_ ? 1.0 : 0.0;
  const double raw = Clamp01((now_s_ - morph_start_s_) / kMorphDurationS);
  morph_ = morph_from_ + (target - morph_from_) * EaseOutCubic(raw);
  // 约每 2 秒做一次前台全屏检查。
  static ULONGLONG last_check = 0;
  if (now - last_check >= 2000) {
    last_check = now;
    UpdateFullscreenSuppression();
  }
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::UpdateFullscreenSuppression() {
  QUERY_USER_NOTIFICATION_STATE state;
  if (FAILED(SHQueryUserNotificationState(&state))) return;
  const bool busy = state == QUNS_RUNNING_D3D_FULL_SCREEN ||
                    state == QUNS_PRESENTATION_MODE || state == QUNS_BUSY;
  if (busy == suppressed_by_fullscreen_) return;
  suppressed_by_fullscreen_ = busy;
  if (window_handle_ == nullptr) return;
  if (busy) {
    ShowWindow(window_handle_, SW_HIDE);
    StopAnimTimer();
  } else if (visible_) {
    PositionAtTopCenter();
    ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
    StartAnimTimer();
  }
}

int DynamicIslandWindow::CompactWidth() const {
  if (!has_entry_) return kRestCapsuleW;
  const std::wstring title = Utf8ToWide(entry_.title);
  const std::wstring trailing = Utf8ToWide(entry_.trailing);
  // CJK 字形宽约为字号；ASCII 约一半。粗估足够，渲染用 MeasureString 实测。
  auto width_of = [](const std::wstring& t) {
    int w = 0;
    for (wchar_t c : t) w += (c < 0x2E80) ? 9 : 17;
    return w;
  };
  int w = 14 + 8 + width_of(title) + 9;
  if (entry_.spinning) w += 15;
  if (!trailing.empty()) w += width_of(trailing);
  w += 14;
  return std::clamp(w, 70, 560);
}

int DynamicIslandWindow::ExpandedHeight() const {
  const int rows = std::clamp(static_cast<int>(agenda_.size()), 0, kMaxRows);
  return 30 + 12 + 20 + rows * kRowH + (rows > 0 ? 6 : 0) + kBtnRowH + 10;
}

void DynamicIslandWindow::Render() {
  if (window_handle_ == nullptr) return;

  const int phys_w = S(kWindowW);
  const int phys_h = S(kWindowH);
  const float s = static_cast<float>(dpi_scale_);

  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);

  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = phys_w;
  bmi.bmiHeader.biHeight = -phys_h;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (dib == nullptr || bits == nullptr) {
    // GDI 资源临时枯竭兜底：跳过本帧，绝不能拿空位图往下画（越界读必崩）。
    DeleteDC(mem_dc);
    ReleaseDC(nullptr, screen_dc);
    return;
  }
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem_dc, dib));

  button_rects_.clear();

  {
    Gdiplus::Graphics g(mem_dc);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
    g.Clear(Gdiplus::Color(0, 0, 0, 0));

    // ── 胶囊几何：compact ⇄ expanded 连续变形 ──
    const int compact_w = CompactWidth();
    const int exp_h = ExpandedHeight();
    const float cur_w =
        static_cast<float>((compact_w + (kExpandedW - compact_w) * morph_)) * s;
    const float cur_h =
        static_cast<float>((kCapsuleH + (exp_h - kCapsuleH) * morph_)) * s;
    const float radius = static_cast<float>(15 + (26 - 15) * morph_) * s;
    // attention 缩放：提醒时刻整体放大（几何 + 内容统一经变换缩放）。
    double att = AttentionScale();
    if (attention_start_s_ >= 0 &&
        now_s_ - attention_start_s_ >
            kAttnInS + kAttnHoldS + kAttnOutS) {
      attention_start_s_ = -1;  // 动画播完自动复位
      att = 1.0;
    }
    // 基座几何（不含 attention）；attention 靠围绕胶囊中心的变换放大。
    const float cap_x = (phys_w - cur_w) / 2.0f;
    const float cap_y = static_cast<float>(S(kTopMargin));
    const float base_cx = cap_x + cur_w / 2.0f;
    const float base_cy = cap_y + cur_h / 2.0f;

    // attention 时整体放大后顶缘固定在 2px：反解放变换中心的 Y。
    // 顶缘映射 t = P + att*(cap_y - P)  =>  P = (t - att*cap_y)/(1-att)。
    float att_cy = base_cy;
    float att_top = cap_y;
    if (att > 1.0) {
      // 展开态底片过高时钳制缩放，保证放大后不越出窗口底。
      const float max_att =
          cur_h > 1.0f
              ? std::min(2.0f, (static_cast<float>(phys_h) - 4.0f) / cur_h)
              : 2.0f;
      if (att > max_att) att = max_att;
      att_top = 2.0f * s;
      att_cy = (att_top - static_cast<float>(att) * cap_y) /
               (1.0f - static_cast<float>(att));
    }

    // attention 变换：围绕（下移后的）中心放大，内容照常画在基座坐标。
    if (att != 1.0) {
      g.TranslateTransform(base_cx, att_cy);
      g.ScaleTransform(static_cast<float>(att), static_cast<float>(att));
      g.TranslateTransform(-base_cx, -att_cy);
    }

    Gdiplus::GraphicsPath cap_path;
    RoundedPath(&cap_path, Gdiplus::RectF(cap_x, cap_y, cur_w, cur_h), radius);

    // ── 沿边缘的细环光（呼吸灯 / attention 强脉冲共用画法）──
    // 贴着胶囊轮廓描三圈白环（内亮外淡、渐宽），随后不透明填充盖住
    // 每圈的内半，露出的部分就是精确沿轮廓的细光边（Apple 式 rim
    // light），不再是整片糊状光斑。描边受当前变换作用，attention
    // 放大时光环随之等比放大。
    auto drawRimRings = [&g, &cap_path, s](BYTE core_alpha) {
      const struct Ring {
        float width;      // 描边宽（逻辑 px）
        float alpha_scale;  // 相对核心 alpha
      } rings[] = {{3.0f, 1.0f}, {7.0f, 0.45f}, {13.0f, 0.18f}};
      for (const Ring& ring : rings) {
        Gdiplus::Pen pen(
            Gdiplus::Color(static_cast<BYTE>(core_alpha * ring.alpha_scale),
                           255, 255, 255),
            ring.width * s);
        g.DrawPath(&pen, &cap_path);
      }
    };

    if (att > 1.5) {
      // attention：强脉冲 rim（0.9s 周期）。
      const double pulse = 0.5 + 0.5 * std::sin(now_s_ * 6.2832 / 0.9);
      drawRimRings(static_cast<BYTE>(110 + 110 * pulse));
    } else if (morph_ < 0.3) {
      // 呼吸灯分档（仅 compact；展开卡静态不呼吸）：
      // 待机 4s/30-70；任务进行中 2.8s/60-130；更新下载 3.5s/45-100；
      // 日程/简报/未读静态。
      double period = 0.0, a0 = 0.0, a1 = 0.0;
      if (!has_entry_) {
        period = 4.0; a0 = 30; a1 = 70;
      } else if (entry_.spinning) {
        period = 2.8; a0 = 60; a1 = 130;
      } else if (entry_.progress >= 0 && entry_.progress <= 1) {
        period = 3.5; a0 = 45; a1 = 100;
      }
      if (period > 0.0) {
        const double ph = 0.5 + 0.5 * std::sin(now_s_ * 6.2831853 / period);
        drawRimRings(static_cast<BYTE>(a0 + (a1 - a0) * ph));
      }
    }

    Gdiplus::SolidBrush cap_brush(Gdiplus::Color(255, 2, 2, 2));
    g.FillPath(&cap_brush, &cap_path);

    // 内容全部裁剪在胶囊内。
    g.SetClip(&cap_path);

    // ── 头部行（compact 内容 / 展开态保留为头部）──
    const float header_h = static_cast<float>(kCapsuleH) * s;
    const float header_cy = cap_y + header_h / 2.0f;

    if (!has_entry_) {
      // 待机：金属球镜头 + 呼吸光。
      const float r = 5.0f * s * (1.0f - 0.25f * static_cast<float>(morph_));
      const float cx = phys_w / 2.0f;
      const double breath = 0.5 + 0.5 * std::sin(now_s_ * 2.2439948);  // 2.8s 周期
      const float glow_r = r * (2.2f + 0.5f * static_cast<float>(breath));
      Gdiplus::GraphicsPath glow_path;
      glow_path.AddEllipse(cx - glow_r, header_cy - glow_r, glow_r * 2,
                           glow_r * 2);
      Gdiplus::PathGradientBrush glow_brush(&glow_path);
      glow_brush.SetCenterColor(Gdiplus::Color(
          static_cast<BYTE>(20 + 55 * breath), 255, 255, 255));
      const Gdiplus::Color glow_surround(0, 255, 255, 255);
      INT sc = 1;
      glow_brush.SetSurroundColors(&glow_surround, &sc);
      g.FillPath(&glow_brush, &glow_path);

      Gdiplus::GraphicsPath sphere_path;
      sphere_path.AddEllipse(cx - r, header_cy - r, r * 2, r * 2);
      Gdiplus::PathGradientBrush sphere_brush(&sphere_path);
      sphere_brush.SetCenterPoint(
          Gdiplus::PointF(cx - r * 0.35f, header_cy - r * 0.4f));
      sphere_brush.SetCenterColor(Gdiplus::Color(255, 244, 245, 247));
      const Gdiplus::Color sphere_surround(255, 20, 21, 25);
      sphere_brush.SetSurroundColors(&sphere_surround, &sc);
      g.FillPath(&sphere_brush, &sphere_path);

      Gdiplus::SolidBrush hl(Gdiplus::Color(150, 255, 255, 255));
      g.FillEllipse(&hl, cx - r * 0.55f, header_cy - r * 0.62f, r * 0.5f,
                    r * 0.42f);
    } else {
      // 内容头部：图标 + 标题 + 尾注/活点，整体在头部行居中。
      // attention 提醒期间标题/尾注切换为提醒文案（若下发）。
      const std::wstring title =
          attention_start_s_ >= 0 && !attention_title_.empty()
              ? attention_title_
              : Utf8ToWide(entry_.title);
      const std::wstring trailing =
          attention_start_s_ >= 0 && !attention_trailing_.empty()
              ? attention_trailing_
              : Utf8ToWide(entry_.trailing);
      Gdiplus::Font icon_font(mem_dc, MakeIslandGlyphFont(S(15)));
      Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(17), 600));
      Gdiplus::Font trail_font(mem_dc, MakeIslandFont(S(14), 600));

      Gdiplus::RectF m_icon, m_title, m_trail;
      const wchar_t* glyph = KindGlyph(entry_.kind);
      g.MeasureString(glyph, -1, &icon_font, Gdiplus::PointF(0, 0), &m_icon);
      g.MeasureString(title.c_str(), -1, &title_font, Gdiplus::PointF(0, 0),
                      &m_title);
      if (!trailing.empty()) {
        g.MeasureString(trailing.c_str(), -1, &trail_font,
                        Gdiplus::PointF(0, 0), &m_trail);
      }
      const float icon_w = entry_.spinning ? 0.0f : m_icon.Width;
      const float trail_w =
          entry_.spinning ? 5.0f * s : m_trail.Width;
      const float gap = 7.0f * s;
      const float total = icon_w + gap + m_title.Width + 8.0f * s + trail_w;
      float x = cap_x + (cur_w - total) / 2.0f;

      const float icon_cy = header_cy;
      if (!entry_.spinning) {
        // task/briefing/inbox 用矢量图标（对应字形在 MDL2 缺失或为豆腐块）。
        if (entry_.kind == DynamicIslandWindow::Kind::kTask) {
          DrawTaskIcon(g, x + m_icon.Width / 2.0f, icon_cy, 6.5f * s,
                       now_s_);
        } else if (entry_.kind == DynamicIslandWindow::Kind::kBriefing) {
          DrawDocIcon(g, x + m_icon.Width / 2.0f, icon_cy, 11.0f * s,
                      13.0f * s);
        } else if (entry_.kind == DynamicIslandWindow::Kind::kInbox) {
          DrawMailIcon(g, x + m_icon.Width / 2.0f, icon_cy, 13.0f * s,
                       10.0f * s);
        } else {
          Gdiplus::SolidBrush icon_brush(Gdiplus::Color(190, 255, 255, 255));
          g.DrawString(glyph, -1, &icon_font,
                       Gdiplus::PointF(x, header_cy - m_icon.Height / 2.0f),
                       &icon_brush);
        }
      }
      x += icon_w + gap;
      Gdiplus::SolidBrush title_brush(Gdiplus::Color(236, 236, 236));
      g.DrawString(title.c_str(), -1, &title_font,
                   Gdiplus::PointF(x, header_cy - m_title.Height / 2.0f),
                   &title_brush);
      x += m_title.Width + 8.0f * s;
      if (entry_.spinning) {
        // 呼吸活点
        const double pulse = 0.5 + 0.5 * std::sin(now_s_ * 4.4879895);  // 1.4s 周期
        const float dot_r = 2.5f * s;
        Gdiplus::SolidBrush dot_brush(
            Gdiplus::Color(static_cast<BYTE>(64 + 165 * pulse), 255, 255, 255));
        g.FillEllipse(&dot_brush, x, header_cy - dot_r, dot_r * 2, dot_r * 2);
      } else if (!trailing.empty()) {
        Gdiplus::SolidBrush trail_brush(Gdiplus::Color(107, 255, 255, 255));
        g.DrawString(trailing.c_str(), -1, &trail_font,
                     Gdiplus::PointF(x, header_cy - m_trail.Height / 2.0f),
                     &trail_brush);
      }

      // 进度线（贴头部行底缘，仅 compact 态；展开后无意义）
      if (entry_.progress >= 0 && entry_.progress <= 1 && morph_ < 0.5) {
        const float line_y = cap_y + header_h - 3.0f * s;
        const float inset = 14.0f * s;
        const float track_w = cur_w - inset * 2;
        const float line_h = 2.0f * s;
        Gdiplus::SolidBrush track_brush(Gdiplus::Color(26, 255, 255, 255));
        g.FillRectangle(&track_brush, cap_x + inset, line_y, track_w, line_h);
        Gdiplus::SolidBrush fill_brush(Gdiplus::Color(230, 255, 255, 255));
        g.FillRectangle(&fill_brush, cap_x + inset, line_y,
                        track_w * static_cast<float>(entry_.progress), line_h);
      }
    }

    // ── 展开区：日程卡（随 morph 淡入）──
    if (morph_ > 0.01) {
      const BYTE fade = static_cast<BYTE>(255 * Clamp01(morph_ * 1.2));
      const float pad = 18.0f * s;
      float y = cap_y + header_h + 6.0f * s;

      Gdiplus::SolidBrush div_brush(
          Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
      g.FillRectangle(&div_brush, cap_x + pad, y, cur_w - pad * 2, 1.0f * s);
      y += 6.0f * s;

      Gdiplus::Font label_font(mem_dc, MakeIslandFont(S(13), 700));
      const std::wstring label = L"接下来";
      Gdiplus::SolidBrush label_brush(
          Gdiplus::Color(static_cast<BYTE>(fade * 38 / 100), 255, 255, 255));
      g.DrawString(label.c_str(), -1, &label_font,
                   Gdiplus::PointF(cap_x + pad, y), &label_brush);
      y += 20.0f * s;

      if (!agenda_.empty()) {
        Gdiplus::Font time_font(mem_dc, MakeIslandFont(S(14), 700));
        Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(18), 600));
        Gdiplus::Font done_font(mem_dc, MakeIslandFont(S(18), 600, true));
        Gdiplus::Font hint_font(mem_dc, MakeIslandFont(S(14), 500));
        const int rows = std::min(static_cast<int>(agenda_.size()), kMaxRows);
        for (int i = 0; i < rows; i++) {
          const AgendaItem& it = agenda_[i];
          const std::wstring time_w = Utf8ToWide(it.time_text);
          const std::wstring title_w = Utf8ToWide(it.title);
          const std::wstring hint_w = Utf8ToWide(it.hint);
          const bool is_near = !it.completed;
          Gdiplus::RectF m_t;
          g.MeasureString(time_w.c_str(), -1, &time_font,
                          Gdiplus::PointF(0, 0), &m_t);
          Gdiplus::SolidBrush time_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * (is_near ? 55 : 30) / 100), 255, 255, 255));
          g.DrawString(time_w.c_str(), -1, &time_font,
                       Gdiplus::PointF(cap_x + pad, y), &time_brush);
          Gdiplus::SolidBrush title_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * (is_near ? 92 : 38) / 100), 255, 255, 255));
          g.DrawString(title_w.c_str(), -1, is_near ? &title_font : &done_font,
                       Gdiplus::PointF(cap_x + pad + m_t.Width + 10.0f * s, y),
                       &title_brush);
          if (!hint_w.empty()) {
            Gdiplus::RectF m_hint;
            g.MeasureString(hint_w.c_str(), -1, &hint_font,
                            Gdiplus::PointF(0, 0), &m_hint);
            Gdiplus::SolidBrush hint_brush(Gdiplus::Color(
                static_cast<BYTE>(fade * 28 / 100), 255, 255, 255));
            g.DrawString(
                hint_w.c_str(), -1, &hint_font,
                Gdiplus::PointF(cap_x + cur_w - pad - m_hint.Width, y),
                &hint_brush);
          }
          y += static_cast<float>(kRowH) * s;
        }
        y += 6.0f * s;
      }

      // 快捷按钮行
      Gdiplus::Font btn_font(mem_dc, MakeIslandFont(S(15), 600));
      const float btn_h = 26.0f * s;
      float bx = cap_x + 10.0f * s;
      for (int i = 0; i < kActionCount; i++) {
        Gdiplus::RectF m_btn;
        g.MeasureString(kActionLabels[i], -1, &btn_font, Gdiplus::PointF(0, 0),
                        &m_btn);
        const float btn_w = m_btn.Width + 20.0f * s;
        const bool hov = hovering_ && hover_btn_ == i;
        if (hov) {
          Gdiplus::SolidBrush btn_hover(Gdiplus::Color(
              static_cast<BYTE>(fade * 9 / 100), 255, 255, 255));
          Gdiplus::GraphicsPath btn_path;
          RoundedPath(&btn_path, Gdiplus::RectF(bx, y, btn_w, btn_h), 8.0f * s);
          g.FillPath(&btn_hover, &btn_path);
        }
        const BYTE a = static_cast<BYTE>(fade * (hov ? 92 : 52) / 100);
        Gdiplus::SolidBrush btn_brush(Gdiplus::Color(a, 255, 255, 255));
        g.DrawString(kActionLabels[i], -1, &btn_font,
                     Gdiplus::PointF(bx + 10.0f * s, y + (btn_h - m_btn.Height) / 2.0f),
                     &btn_brush);
        RECT rc = {static_cast<LONG>(bx), static_cast<LONG>(y),
                   static_cast<LONG>(bx + btn_w), static_cast<LONG>(y + btn_h)};
        button_rects_.push_back(rc);
        bx += btn_w + 4.0f * s;
      }
    }

    g.ResetClip();
  }

  // GDI+ 写入的是 straight alpha；UpdateLayeredWindow 需要 premultiplied。
  {
    DWORD* px = static_cast<DWORD*>(bits);
    const int total = phys_w * phys_h;
    for (int i = 0; i < total; i++) {
      const DWORD v = px[i];
      const BYTE a = static_cast<BYTE>(v >> 24);
      if (a == 255 || a == 0) continue;
      const BYTE r = static_cast<BYTE>((v & 0xFF) * a / 255);
      const BYTE gr = static_cast<BYTE>(((v >> 8) & 0xFF) * a / 255);
      const BYTE b = static_cast<BYTE>(((v >> 16) & 0xFF) * a / 255);
      px[i] = (static_cast<DWORD>(a) << 24) | (static_cast<DWORD>(b) << 16) |
              (static_cast<DWORD>(gr) << 8) | r;
    }
  }

  RECT wr;
  GetWindowRect(window_handle_, &wr);
  POINT dst = {wr.left, wr.top};
  POINT src = {0, 0};
  SIZE size = {phys_w, phys_h};
  BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(window_handle_, screen_dc, &dst, &size, mem_dc, &src, 0,
                      &blend, ULW_ALPHA);

  SelectObject(mem_dc, old_bmp);
  DeleteObject(dib);
  DeleteDC(mem_dc);
  ReleaseDC(nullptr, screen_dc);
}

int DynamicIslandWindow::HoverButtonAt(int client_x, int client_y) const {
  for (size_t i = 0; i < button_rects_.size(); i++) {
    const RECT& rc = button_rects_[i];
    if (client_x >= rc.left && client_x <= rc.right && client_y >= rc.top &&
        client_y <= rc.bottom) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

LRESULT CALLBACK DynamicIslandWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  DynamicIslandWindow* self = nullptr;
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCTW*>(lparam);
    self = static_cast<DynamicIslandWindow*>(cs->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(self));
  } else {
    self = reinterpret_cast<DynamicIslandWindow*>(
        GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  }
  if (self == nullptr) return DefWindowProcW(hwnd, message, wparam, lparam);
  return self->HandleMessage(hwnd, message, wparam, lparam);
}

LRESULT DynamicIslandWindow::HandleMessage(HWND hwnd, UINT message,
                                            WPARAM wparam,
                                            LPARAM lparam) noexcept {
  switch (message) {
    case WM_PAINT: {
      ValidateRect(hwnd, nullptr);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (wparam == 1) {
        UpdateAnimations();
      } else if (wparam == 2) {
        KillTimer(hwnd, 2);
        if (expanded_ && !hovering_ && attention_start_s_ < 0) {
          SetExpanded(false);
          FireEvent(EventType::kExpandedChanged, "false");
        }
      }
      return 0;
    case WM_NCHITTEST:
      return HTCLIENT;  // 岛形以外 alpha=0，系统自动穿透
    case WM_LBUTTONDOWN: {
      const int btn = HoverButtonAt(GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam));
      if (btn >= 0) {
        char utf8[128] = {};
        WideCharToMultiByte(CP_UTF8, 0, kActionLabels[btn], -1, utf8,
                            sizeof(utf8), nullptr, nullptr);
        FireEvent(EventType::kAction, utf8);
        return 0;
      }
      SetExpanded(!expanded_);
      FireEvent(EventType::kExpandedChanged, expanded_ ? "true" : "false");
      return 0;
    }
    case WM_MOUSEMOVE: {
      const int btn = HoverButtonAt(GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam));
      hovering_ = true;
      if (expanded_) KillTimer(hwnd, 2);  // 鼠标回到岛上：取消自动收回

      if (!tracking_mouse_) {
        TRACKMOUSEEVENT tme = {sizeof(TRACKMOUSEEVENT), TME_LEAVE, hwnd, 0};
        TrackMouseEvent(&tme);
        tracking_mouse_ = true;
      }
      if (btn != hover_btn_) {
        hover_btn_ = btn;
        Render();
      }
      return 0;
    }
    case WM_MOUSELEAVE:
      hovering_ = false;
      tracking_mouse_ = false;
      hover_btn_ = -1;
      Render();
      // 人为展开后鼠标离开：3 秒后自动收回（attention 期间不收）。
      if (expanded_ && attention_start_s_ < 0) {
        SetTimer(hwnd, 2, 3000, nullptr);
      }
      return 0;
    case WM_DPICHANGED: {
      const UINT dpi = static_cast<UINT>(HIWORD(wparam));
      if (dpi != 0) {
        dpi_scale_ = static_cast<double>(dpi) / USER_DEFAULT_SCREEN_DPI;
        PositionAtTopCenter();
        Render();
      }
      return 0;
    }
    case WM_DISPLAYCHANGE:
      PositionAtTopCenter();
      Render();
      return 0;
    case WM_DESTROY:
      StopAnimTimer();
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

void DynamicIslandWindow::FireEvent(EventType type, const std::string& payload) {
  if (event_callback_) event_callback_(type, payload);
}
