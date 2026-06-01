#ifndef RUNNER_DESKTOP_SCREEN_CAPTURE_H_
#define RUNNER_DESKTOP_SCREEN_CAPTURE_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// Capture screen (optional region [left, top, width, height]), output PNG bytes.
struct DesktopScreenshotResult {
  bool ok = false;
  std::string error;
  std::vector<uint8_t> png_bytes;
  int width = 0;
  int height = 0;
};

std::optional<DesktopScreenshotResult> CaptureDesktopPng(
    std::optional<int> left,
    std::optional<int> top,
    std::optional<int> width,
    std::optional<int> height);

#endif  // RUNNER_DESKTOP_SCREEN_CAPTURE_H_
