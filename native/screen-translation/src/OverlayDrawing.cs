using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Web.Script.Serialization;

namespace Arkdown.ScreenTranslation
{
    // Draw offscreen as well as in the Form, so transparency and glyph placement
    // can be validated without opening an overlay window.
    internal static class OverlayDrawing
    {
        sealed class CrosshairGeometry
        {
            public float viewBox { get; set; }
            public float sizeCss { get; set; }
            public string color { get; set; }
            public float strokeWidth { get; set; }
            public float center { get; set; }
            public float[] radii { get; set; }
            public float[][] arms { get; set; }
        }
        static readonly CrosshairGeometry crosshair = LoadCrosshair();
        static CrosshairGeometry LoadCrosshair()
        {
            using (var stream = typeof(OverlayDrawing).Assembly.GetManifestResourceStream("screen-translation-crosshair.json"))
            using (var reader = new StreamReader(stream)) return new JavaScriptSerializer().Deserialize<CrosshairGeometry>(reader.ReadToEnd());
        }
        internal static void DrawHeader(Graphics graphics, int dpi)
        {
            var drag = OverlayMetrics.DragBounds(dpi);
            Func<double, int> scale = css => OverlayMetrics.Pixels(css, dpi);
            // Color-key windows have binary transparency. Anti-aliasing the outside
            // edge against the key blends near-black pixels that Windows cannot
            // remove. Rasterize that boundary opaquely; smooth the interior only.
            graphics.SmoothingMode = SmoothingMode.None;
            using (var shape = new GraphicsPath()) {
                int diameter = scale(8);
                shape.AddArc(drag.Left, drag.Top, diameter, diameter, 180, 90);
                shape.AddArc(drag.Right - diameter, drag.Top, diameter, diameter, 270, 90);
                shape.AddArc(drag.Right - diameter, drag.Bottom - diameter, diameter, diameter, 0, 90);
                shape.AddArc(drag.Left, drag.Bottom - diameter, diameter, diameter, 90, 90); shape.CloseFigure();
                using (var background = new SolidBrush(SurfaceTheme.Background)) graphics.FillPath(background, shape);
                using (var border = new Pen(SurfaceTheme.Border)) graphics.DrawPath(border, shape);
            }
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var saved = graphics.Save();
            float factor = crosshair.sizeCss * dpi / 96f / crosshair.viewBox;
            float cx = drag.Left + scale(12), cy = drag.Top + drag.Height / 2f;
            graphics.TranslateTransform(cx - crosshair.center * factor, cy - crosshair.center * factor);
            graphics.ScaleTransform(factor, factor);
            using (var pen = new Pen(ColorTranslator.FromHtml(crosshair.color), crosshair.strokeWidth)) {
                pen.StartCap = pen.EndCap = LineCap.Round;
                foreach (float radius in crosshair.radii) graphics.DrawEllipse(pen, crosshair.center - radius, crosshair.center - radius, radius * 2, radius * 2);
                foreach (var arm in crosshair.arms) graphics.DrawLine(pen, arm[0], arm[1], arm[2], arm[3]);
            }
            graphics.Restore(saved);
            using (var font = SurfaceTheme.Font(scale(13.0 / 1.5))) using (var ink = new SolidBrush(SurfaceTheme.Foreground))
            using (var glyphs = new GraphicsPath()) using (var transform = new Matrix()) {
                // Center visible glyphs, independent of the loaded font's ascent,
                // descent and line-gap padding used by DrawString's line box.
                glyphs.AddString("悬浮翻译窗", font.FontFamily, (int)font.Style, font.Size, PointF.Empty, StringFormat.GenericTypographic);
                var bounds = glyphs.GetBounds();
                // GDI+ samples integer pixel centers; offset by half a physical
                // pixel so the raster ink center follows the rectangle center.
                transform.Translate(drag.Left + scale(25) - bounds.Left, cy - bounds.Top - bounds.Height / 2 - 0.5f);
                glyphs.Transform(transform); graphics.FillPath(ink, glyphs);
            }
        }
    }
}
