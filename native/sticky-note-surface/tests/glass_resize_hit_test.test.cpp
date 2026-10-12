#include "../src/glass_resize_hit_test.h"

using sticky_note_resize::SupplementalHit;
using sticky_note_resize::ShouldHandleResizePress;
using sticky_note_resize::ShouldRouteResizePress;
using sticky_note_resize::SupplementalCursorResource;

// The resize hit and the displayed cursor are separate Win32 contracts.
// Match the current gutter, leave native top/caption/client cursors alone,
// and reject a stale WM_SETCURSOR hit after geometry has changed.
static_assert(SupplementalCursorResource(1, 10, 10) == 32644); // IDC_SIZEWE
static_assert(SupplementalCursorResource(0, 11, 11) == 32644);
static_assert(SupplementalCursorResource(1, 15, 15) == 32645); // IDC_SIZENS
static_assert(SupplementalCursorResource(1, 16, 16) == 32643); // IDC_SIZENESW
static_assert(SupplementalCursorResource(1, 17, 17) == 32642); // IDC_SIZENWSE
static_assert(SupplementalCursorResource(1, 10, 11) == 0);
static_assert(SupplementalCursorResource(1, 1, 10) == 0);
static_assert(SupplementalCursorResource(1, 1, 1) == 0);
static_assert(SupplementalCursorResource(12, 12, 12) == 0);
static_assert(SupplementalCursorResource(2, 2, 2) == 0);
static_assert(SupplementalCursorResource(20, 20, 20) == 0);
static_assert(SupplementalCursorResource(17, 17, 17) == 0);

// USER32 may deliver the real non-client press to the parent even when the
// legacy child supplied the hit. Both routes must exclude client input.
static_assert(ShouldRouteResizePress(0x00A1, 1,
  SupplementalHit(1, 561, 460, 562, 461, 144, true, true), 17));
static_assert(!ShouldRouteResizePress(0x0201, 1, 17, 17));
static_assert(!ShouldRouteResizePress(0x0084, 1, 17, 17));
static_assert(!ShouldRouteResizePress(0x00A1, 17, 17, 17));
static_assert(!ShouldRouteResizePress(0x00A1, 1,
  SupplementalHit(1, 558, 300, 562, 461, 144, true, true), 17));
static_assert(!ShouldRouteResizePress(0x00A1, 1, 17, 16));

// Only a real press matching a newly supplemented gutter may bypass Aura.
static_assert(ShouldHandleResizePress(1, 17, 17));
static_assert(ShouldHandleResizePress(0, 10, 10));
static_assert(!ShouldHandleResizePress(17, 17, 17));
static_assert(!ShouldHandleResizePress(1, 17, 16));
static_assert(!ShouldHandleResizePress(1, 1, 1));
static_assert(!ShouldHandleResizePress(1, 12, 12));
static_assert(!ShouldHandleResizePress(1, 2, 2));
static_assert(!ShouldHandleResizePress(20, 17, 17));
static_assert(!ShouldHandleResizePress(-1, 17, 17));

// Real 150% candidate client size. HTCLIENT=1, HTLEFT=10, HTRIGHT=11,
// HTBOTTOM=15, HTBOTTOMLEFT=16 and HTBOTTOMRIGHT=17.
static_assert(SupplementalHit(1, 560, 300, 562, 461, 144, true, true) == 11);
static_assert(SupplementalHit(1, 2, 300, 562, 461, 144, true, true) == 10);
static_assert(SupplementalHit(1, 280, 459, 562, 461, 144, true, true) == 15);
static_assert(SupplementalHit(1, 557, 456, 562, 461, 144, true, true) == 17);
static_assert(SupplementalHit(1, 4, 456, 562, 461, 144, true, true) == 16);
static_assert(SupplementalHit(0, 557, 456, 562, 461, 144, true, true) == 17);

// Preserve the existing top resize, caption dragging and native control hits.
static_assert(SupplementalHit(12, 280, 1, 562, 461, 144, true, true) == 12);
static_assert(SupplementalHit(14, 559, 1, 562, 461, 144, true, true) == 14);
static_assert(SupplementalHit(2, 2, 20, 562, 461, 144, true, true) == 2);
static_assert(SupplementalHit(20, 560, 10, 562, 461, 144, true, true) == 20);
static_assert(SupplementalHit(-1, 560, 10, 562, 461, 144, true, true) == -1);
static_assert(SupplementalHit(1, 280, 1, 562, 461, 144, true, true) == 1);

// A press 4 DIP inside the visible glass edge must resize, not select text.
static_assert(SupplementalHit(1, 6, 200, 623, 507, 144, true, true) == 10);
static_assert(SupplementalHit(1, 616, 200, 623, 507, 144, true, true) == 11);
static_assert(SupplementalHit(1, 300, 500, 623, 507, 144, true, true) == 15);

// All three edges expose 6 DIP. The renderer moves the scrollbar 7 CSS px
// inward and toolbar buttons 8 CSS px inward, leaving a rounding margin.
// Check odd native sizes too: Chromium's layout can be one physical px wider.
constexpr bool CheckGutters(unsigned dpi, int width, int height) {
  const int edge = static_cast<int>(6ull * dpi / 96);
  const int corner = static_cast<int>(16ull * dpi / 96);
  const int scrollbarRight = width + 1 - static_cast<int>(7ull * dpi / 96);
  const int buttonRight = width + 1 - static_cast<int>(8ull * dpi / 96);
  const int buttonLeft = static_cast<int>(8ull * dpi / 96);
  const int buttonBottom = height + 1 - static_cast<int>(8ull * dpi / 96);
  return SupplementalHit(1, edge - 1, height / 2, width, height, dpi, true, true) == 10
    && SupplementalHit(1, edge, height / 2, width, height, dpi, true, true) == 1
    && SupplementalHit(1, width - edge, height / 2, width, height, dpi, true, true) == 11
    && SupplementalHit(1, width - edge - 1, height / 2, width, height, dpi, true, true) == 1
    && SupplementalHit(1, width / 2, height - edge, width, height, dpi, true, true) == 15
    && SupplementalHit(1, width / 2, height - edge - 1, width, height, dpi, true, true) == 1
    && SupplementalHit(1, edge - 1, height - corner, width, height, dpi, true, true) == 16
    && SupplementalHit(1, width - edge, height - corner, width, height, dpi, true, true) == 17
    && SupplementalHit(1, edge - 1, height - corner - 1, width, height, dpi, true, true) == 10
    && SupplementalHit(1, width - edge, height - corner - 1, width, height, dpi, true, true) == 11
    && SupplementalHit(1, corner - 1, height - 1, width, height, dpi, true, true) == 16
    && SupplementalHit(1, width - corner, height - 1, width, height, dpi, true, true) == 17
    && SupplementalHit(1, corner, height - 1, width, height, dpi, true, true) == 15
    && SupplementalHit(1, width - corner - 1, height - 1, width, height, dpi, true, true) == 15
    && SupplementalHit(1, scrollbarRight - 1, height / 2, width, height, dpi, true, true) == 1
    && SupplementalHit(1, buttonLeft, buttonBottom - 1, width, height, dpi, true, true) == 1
    && SupplementalHit(1, buttonRight - 1, buttonBottom - 1, width, height, dpi, true, true) == 1;
}
static_assert(CheckGutters(96, 400, 300));
static_assert(CheckGutters(120, 501, 377));
static_assert(CheckGutters(144, 623, 507));
static_assert(CheckGutters(168, 701, 527));
static_assert(CheckGutters(192, 801, 601));
static_assert(CheckGutters(144, 270, 270));

// Disabled scope/capability and points outside the actual client are untouched.
static_assert(SupplementalHit(1, 560, 300, 562, 461, 144, false, true) == 1);
static_assert(SupplementalHit(1, 560, 300, 562, 461, 144, true, false) == 1);
static_assert(SupplementalHit(1, -1, 300, 562, 461, 144, true, true) == 1);
static_assert(SupplementalHit(1, 562, 300, 562, 461, 144, true, true) == 1);
static_assert(SupplementalHit(1, 100, 461, 562, 461, 144, true, true) == 1);
static_assert(SupplementalHit(1, 0, 0, 0, 0, 144, true, true) == 1);
static_assert(SupplementalHit(1, 0, 0, 1, 1, 144, true, true) == 1);
static_assert(SupplementalHit(1, 560, 300, 562, 461, 0, true, true) == 1);
