using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Windows.Forms;

namespace Arkdown.ScreenTranslation
{
    internal static class SurfaceTheme
    {
        internal static readonly Color Transparent = Color.FromArgb(1, 2, 3);
        internal static Color Background = Color.FromArgb(245, 245, 245), Foreground = Color.FromArgb(40, 40, 40), Accent = Color.FromArgb(112, 91, 196), Border = Color.FromArgb(168, 163, 180);
        static PrivateFontCollection fonts;
        internal static Font Font(float size) { return fonts != null && fonts.Families.Length > 0 ? new Font(fonts.Families[0], size, FontStyle.Regular, GraphicsUnit.Pixel) : new Font("Microsoft YaHei UI", size, FontStyle.Regular, GraphicsUnit.Pixel); }
        internal static void LoadFont(string path)
        {
            if (path == null) return;
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > 20000000) throw new ArgumentException("The supplied font cannot be loaded.");
            var next = new PrivateFontCollection();
            try { next.AddFontFile(path); } catch { next.Dispose(); throw new ArgumentException("The supplied font cannot be loaded."); }
            if (fonts != null) fonts.Dispose(); fonts = next;
        }
        internal static void Apply(Dictionary<string, string> theme)
        {
            if (theme == null) return;
            Background = Safe(theme["background"]); Foreground = Safe(theme["foreground"]);
            Accent = Safe(theme["accent"]); Border = Safe(theme["border"]);
        }
        static Color Safe(string value) { Color color = ColorTranslator.FromHtml(value); return color.ToArgb() == Transparent.ToArgb() ? Color.FromArgb(2, 3, 4) : color; }
        internal static void Dispose() { if (fonts != null) fonts.Dispose(); fonts = null; }
    }

    internal sealed class OverlayForm : ProtectedForm
    {
        int Dpi { get { try { return Math.Max(96, (int)Native.GetDpiForWindow(Handle)); } catch (EntryPointNotFoundException) { using (var graphics = CreateGraphics()) return (int)graphics.DpiX; } } }
        int Scale(double css) { return OverlayMetrics.Pixels(css, Dpi); }
        int FrameMargin { get { return Scale(4); } }
        int Header { get { return Scale(26); } }
        internal event Action GeometryChanged;
        internal bool Adjusting { get; private set; }
        internal Rectangle CaptureBounds { get { return new Rectangle(Left + FrameMargin, Top + Header, Math.Max(1, Width - 2 * FrameMargin), Math.Max(1, Height - Header - FrameMargin)); } }
        void UpdateMinimumSize() { MinimumSize = new Size(80 + 2 * FrameMargin, 40 + Header + FrameMargin); }
        internal void SetCaptureBounds(Rectangle rectangle) { UpdateMinimumSize(); Bounds = new Rectangle(rectangle.X - FrameMargin, rectangle.Y - Header, rectangle.Width + 2 * FrameMargin, rectangle.Height + Header + FrameMargin); }
        internal OverlayForm()
        {
            Text = "悬浮翻译窗 · 取景框"; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
            DoubleBuffered = true; BackColor = TransparencyKey = SurfaceTheme.Transparent;
            AutoScaleMode = AutoScaleMode.None; StartPosition = FormStartPosition.Manual; MinimumSize = new Size(92, 76);
            Resize += delegate { Changed(); }; Move += delegate { Changed(); };
            ResizeBegin += delegate { Adjusting = true; }; ResizeEnd += delegate { Adjusting = false; Changed(); };
        }
        void Changed() { Invalidate(); if (GeometryChanged != null) GeometryChanged(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); var graphics = e.Graphics;
            OverlayDrawing.DrawHeader(graphics, Dpi);
            using (var pen = new Pen(SurfaceTheme.Accent, 1)) {
                graphics.DrawRectangle(pen, FrameMargin - 1, Header - 1, ClientSize.Width - 2 * FrameMargin + 1, ClientSize.Height - Header - FrameMargin + 1);
            }
            using (var pen = new Pen(SurfaceTheme.Accent, 2)) {
                int left = FrameMargin - 1, right = Width - FrameMargin, top = Header - 1, bottom = Height - FrameMargin;
                foreach (var point in new Point[] { new Point(left, top), new Point(right, top), new Point(left, bottom), new Point(right, bottom) }) {
                    graphics.DrawLine(pen, point, new Point(point.X + (point.X == left ? 12 : -12), point.Y));
                    graphics.DrawLine(pen, point, new Point(point.X, point.Y + (point.Y == top ? 12 : -12)));
                }
            }
            // Color-key-transparent pixels pass through before WM_NCHITTEST. Paint the
            // entire grip so the advertised 15 CSS px square is actually interactive.
            var grip = OverlayMetrics.ResizeBounds(ClientSize, Dpi);
            using (var background = new SolidBrush(SurfaceTheme.Background)) graphics.FillRectangle(background, grip);
            using (var pen = new Pen(SurfaceTheme.Accent, Math.Max(1, Scale(1)))) {
                for (int inset = 4; inset <= 10; inset += 3)
                    graphics.DrawLine(pen, grip.Right - Scale(inset), grip.Bottom - Scale(2), grip.Right - Scale(2), grip.Bottom - Scale(inset));
            }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x84) {
                long value = message.LParam.ToInt64();
                var point = PointToClient(new Point((short)(value & 0xffff), (short)((value >> 16) & 0xffff)));
                if (OverlayMetrics.ResizeBounds(ClientSize, Dpi).Contains(point)) { message.Result = new IntPtr(17); return; }
                if (OverlayMetrics.DragBounds(Dpi).Contains(point)) { message.Result = new IntPtr(2); return; }
                bool left = point.X < FrameMargin + 3, right = point.X >= Width - FrameMargin - 3;
                bool top = point.Y >= Header - 4 && point.Y <= Header + 3, bottom = point.Y >= Height - FrameMargin - 3;
                int hit = left && top ? 13 : right && top ? 14 : left && bottom ? 16 : right && bottom ? 17 : point.Y >= Header - 4 && left ? 10 : point.Y >= Header - 4 && right ? 11 : bottom ? 15 : top ? 12 : -1;
                message.Result = new IntPtr(hit); return;
            }
            base.WndProc(ref message);
            if (message.Msg == 0x02E0) UpdateMinimumSize(); // WM_DPICHANGED: retain valid minimum capture dimensions.
        }
    }

    internal sealed class TranslationSurface : ITranslationSurface
    {
        readonly OverlayForm overlay = new OverlayForm();
        readonly TranslationLayer layer = new TranslationLayer();
        readonly int parentId;
        List<IntPtr> extraWindows = new List<IntPtr>();
        public event Action GeometryChanged;
        public Rectangle Bounds { get { return Rectangle.Intersect(overlay.CaptureBounds, SystemInformation.VirtualScreen); } }
        public bool Adjusting { get { return overlay.Adjusting; } }
        internal TranslationSurface(int parentId)
        {
            this.parentId = parentId;
            var area = Screen.PrimaryScreen.WorkingArea;
            overlay.SetCaptureBounds(new Rectangle(area.Left + 120, area.Top + 160, 600, 280));
            overlay.GeometryChanged += delegate { if (GeometryChanged != null) GeometryChanged(); };
            Native.ShowQuietly(overlay);
        }
        public void Configure(Configuration configuration)
        {
            foreach (var handle in configuration.ExcludedWindowHandles) ValidateExternal(handle);
            SurfaceTheme.LoadFont(configuration.FontPath);
            SurfaceTheme.Apply(configuration.Theme); extraWindows = configuration.ExcludedWindowHandles;
            if (configuration.Bounds.HasValue) overlay.SetCaptureBounds(configuration.Bounds.Value);
            overlay.Invalidate(); layer.Invalidate();
        }
        void ValidateExternal(IntPtr handle)
        {
            uint owner; Native.GetWindowThreadProcessId(handle, out owner);
            if (!Native.IsWindow(handle) || parentId <= 0 || owner != (uint)parentId) throw new ArgumentException("Excluded window must belong to the parent process.");
        }
        public void SetTheme(Dictionary<string, string> theme) { SurfaceTheme.Apply(theme); overlay.Invalidate(); layer.Invalidate(); }
        public void Render(TranslationResult result, bool showOriginal)
        {
            layer.Bounds = Bounds; layer.SetResult(result);
            if (!showOriginal && result != null && result.Blocks.Count > 0) Native.ShowQuietly(layer); else layer.Hide();
        }
        public Bitmap Capture()
        {
            var bounds = Bounds;
            if (bounds.Width < 1 || bounds.Height < 1) throw new ArgumentException("请把取景框移到屏幕范围内。");
            if ((long)bounds.Width * bounds.Height > 20000000) throw new ArgumentException("选区过大，请缩小范围。");
            var hidden = new List<IntPtr>();
            try {
                var windows = new List<IntPtr> { overlay.Handle, layer.Handle };
                foreach (var handle in extraWindows) {
                    // Handles can be reused: recheck ownership and capture affinity for every capture.
                    if (!Native.IsWindow(handle)) continue;
                    ValidateExternal(handle); if (!windows.Contains(handle)) windows.Add(handle);
                }
                foreach (var handle in windows) if (Native.IsWindowVisible(handle) && !Native.IsExcluded(handle)) {
                    hidden.Add(handle); Native.ShowWindow(handle, 0);
                    if (Native.IsWindowVisible(handle)) throw new ArgumentException("无法暂时隐藏翻译面板，请移开面板后重试。");
                }
                if (Native.DwmFlush() < 0) throw new ArgumentException("桌面合成暂不可用，请稍后重试。");
                var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
                try {
                    using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                    return bitmap;
                } catch { bitmap.Dispose(); throw; }
            } finally {
                foreach (var handle in hidden) if (Native.IsWindow(handle)) Native.ShowWindow(handle, 8); // SW_SHOWNA; preserve external z-order.
            }
        }
        public void Dispose() { overlay.Dispose(); layer.Dispose(); SurfaceTheme.Dispose(); }
    }
}
