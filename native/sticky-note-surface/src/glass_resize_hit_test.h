#pragma once

namespace sticky_note_resize {
constexpr bool ShouldHandleResizePress(int original, int supplemented, int pressed) {
  return (original == 0 || original == 1) && supplemented == pressed
    && (supplemented == 10 || supplemented == 11 || supplemented == 15
      || supplemented == 16 || supplemented == 17);
}

constexpr bool ShouldRouteResizePress(unsigned message, int original, int supplemented, int pressed) {
  return message == 0x00A1 && ShouldHandleResizePress(original, supplemented, pressed);
}

// System cursor resource IDs. Claim only a freshly supplemented resize hit;
// native caption/top/control hits and stale cursor messages keep their owner.
constexpr unsigned SupplementalCursorResource(int original, int supplemented, int reported) {
  if (!ShouldHandleResizePress(original, supplemented, reported)) return 0;
  switch (supplemented) {
    case 10: case 11: return 32644; // IDC_SIZEWE
    case 15: return 32645; // IDC_SIZENS
    case 16: return 32643; // IDC_SIZENESW
    case 17: return 32642; // IDC_SIZENWSE
    default: return 0;
  }
}

// Win32 HT codes, kept independent of Windows headers for constexpr tests.
// The existing native top/caption/control results always take precedence.
constexpr int SupplementalHit(int original, int x, int y, int width, int height,
  unsigned dpi, bool enabled, bool resizable) {
  if (!enabled || !resizable || (original != 0 && original != 1) || !dpi
    || width < 2 || height < 2 || x < 0 || y < 0 || x >= width || y >= height)
    return original;
  // Match the glass-only gutters in sticky-note-window.css: a 6 DIP resize
  // band, scrollbar inset 7 CSS px, toolbar buttons inset at least 8 CSS px.
  // That extra clearance covers native/Chromium fractional-DPI rounding.
  // Keep this invisible hit band independent of the glass border and shadow.
  const int scaledSide = static_cast<int>(6ull * dpi / 96);
  const int scaledBottom = scaledSide;
  const int scaledCorner = static_cast<int>(16ull * dpi / 96);
  const int side = scaledSide < (width - 1) / 2 ? scaledSide : (width - 1) / 2;
  const int bottom = scaledBottom < (height - 1) / 2 ? scaledBottom : (height - 1) / 2;
  const int cornerX = scaledCorner < width / 2 ? scaledCorner : width / 2;
  const int cornerY = scaledCorner < height / 2 ? scaledCorner : height / 2;
  if (y >= height - bottom) {
    if (x < cornerX) return 16;
    if (x >= width - cornerX) return 17;
    return 15;
  }
  if (y >= height - cornerY) {
    if (x < side) return 16;
    if (x >= width - side) return 17;
  }
  if (x < side) return 10;
  if (x >= width - side) return 11;
  return original;
}
}
