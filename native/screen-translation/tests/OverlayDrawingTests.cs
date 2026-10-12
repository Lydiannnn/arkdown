using System;
using System.Drawing;
using Arkdown.ScreenTranslation;

class OverlayDrawingTests
{
    static int failures;
    static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    static void Test(string name, Action action) { try { action(); Console.WriteLine("PASS: " + name); } catch (Exception e) { failures++; Console.WriteLine("FAIL: " + name + " - " + e.Message); } }
    static Bitmap Header(int dpi)
    {
        var drag = OverlayMetrics.DragBounds(dpi);
        var bitmap = new Bitmap(drag.Right + 4, drag.Bottom + 4);
        using (var graphics = Graphics.FromImage(bitmap)) { graphics.Clear(SurfaceTheme.Transparent); OverlayDrawing.DrawHeader(graphics, dpi); }
        return bitmap;
    }
    static bool Red(Color pixel) { return pixel.R > 150 && pixel.G < 100 && pixel.B < 100; }
    static int Main()
    {
        SurfaceTheme.LoadFont(System.IO.Path.Combine(Environment.CurrentDirectory, "src/renderer/assets/fonts/NotoSansSC-VF.ttf"));
        foreach (bool dark in new[] { false, true }) {
        SurfaceTheme.Background = dark ? Color.FromArgb(24, 24, 24) : Color.FromArgb(245, 245, 245);
        SurfaceTheme.Foreground = dark ? Color.FromArgb(232, 232, 232) : Color.FromArgb(40, 40, 40);
        SurfaceTheme.Border = dark ? Color.FromArgb(78, 78, 78) : Color.FromArgb(168, 163, 180);
        foreach (int dpiValue in new[] { 96, 144, 192 }) {
            int dpi = dpiValue;
            string label = (dark ? "dark " : "light ") + dpi + " DPI: ";
            Test(label + "rounded corners contain only exact transparent key or opaque surface colors", delegate {
                using (var bitmap = Header(dpi)) {
                    var drag = OverlayMetrics.DragBounds(dpi);
                    Check(bitmap.GetPixel(drag.Right, drag.Top).ToArgb() == SurfaceTheme.Transparent.ToArgb(), "corner did not remain transparent");
                    for (int y = 0; y < bitmap.Height; y++) for (int x = drag.Right - OverlayMetrics.Pixels(8, dpi); x < bitmap.Width; x++) {
                        var pixel = bitmap.GetPixel(x, y);
                        Check(pixel.ToArgb() == SurfaceTheme.Transparent.ToArgb() || (
                            pixel.R >= Math.Min(SurfaceTheme.Background.R, SurfaceTheme.Border.R) &&
                            pixel.G >= Math.Min(SurfaceTheme.Background.G, SurfaceTheme.Border.G) &&
                            pixel.B >= Math.Min(SurfaceTheme.Background.B, SurfaceTheme.Border.B)), "dark color-key fringe at " + x + "," + y + ": " + pixel);
                    }
                }
            });
            Test(label + "red crosshair contains the inner ring", delegate {
                using (var bitmap = Header(dpi)) {
                    var drag = OverlayMetrics.DragBounds(dpi);
                    int cx = drag.Left + OverlayMetrics.Pixels(12, dpi), cy = drag.Top + drag.Height / 2;
                    int radius = (int)Math.Round(32 * 19.0 / 256 * dpi / 96);
                    bool found = false;
                    for (int x = cx + radius - 1; x <= cx + radius + 1; x++) for (int y = cy - 1; y <= cy + 1; y++) found |= Red(bitmap.GetPixel(x, y));
                    Check(found, "Phosphor Crosshair inner ring missing");
                }
            });
            Test(label + "visible label ink is vertically centered", delegate {
                using (var bitmap = Header(dpi)) {
                    var drag = OverlayMetrics.DragBounds(dpi); int top = bitmap.Height, bottom = -1;
                    for (int y = drag.Top; y < drag.Bottom; y++) for (int x = drag.Left + OverlayMetrics.Pixels(25, dpi); x < drag.Right - OverlayMetrics.Pixels(8, dpi); x++) {
                        var pixel = bitmap.GetPixel(x, y);
                        bool ink = dark ? pixel.R > 150 && pixel.G > 150 && pixel.B > 150 : pixel.R < 110 && pixel.G < 110 && pixel.B < 110;
                        if (ink && pixel.ToArgb() != SurfaceTheme.Transparent.ToArgb()) { top = Math.Min(top, y); bottom = Math.Max(bottom, y); }
                    }
                    Check(bottom >= top, "label ink absent");
                    Check(Math.Abs((top + bottom + 1) / 2.0 - (drag.Top + drag.Height / 2.0)) <= 0.5, "label ink offset: " + top + ".." + bottom + " versus " + drag);
                }
            });
            string evidence = Environment.GetEnvironmentVariable("ARKDOWN_OVERLAY_DRAWING_EVIDENCE");
            if (!string.IsNullOrEmpty(evidence)) {
                System.IO.Directory.CreateDirectory(evidence);
                using (var bitmap = Header(dpi)) {
                    bitmap.MakeTransparent(SurfaceTheme.Transparent);
                    bitmap.Save(System.IO.Path.Combine(evidence, (dark ? "dark-" : "light-") + dpi + "dpi.png"), System.Drawing.Imaging.ImageFormat.Png);
                }
            }
        }
        }
        Test("150% acceptance dimensions and 15 CSS px resize grip are preserved", delegate {
            var drag = OverlayMetrics.DragBounds(144);
            Check(drag.Width == 172 && drag.Height == 30, "30% drag enlargement changed");
            Check(OverlayMetrics.ResizeBounds(new Size(600, 300), 144).Size == new Size(23, 23), "resize grip changed");
        });
        Console.WriteLine(failures == 0 ? "ALL OVERLAY DRAWING TESTS PASSED" : failures + " OVERLAY DRAWING TEST(S) FAILED");
        return failures == 0 ? 0 : 1;
    }
}
