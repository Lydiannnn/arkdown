using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace Arkdown.ScreenTranslation
{
    internal static class OverlayMetrics
    {
        // The old header was 132 x 23 physical pixels at the 150% acceptance baseline.
        internal const double DragWidthCss = 132 * 1.3 / 1.5, DragHeightCss = 23 * 1.3 / 1.5;
        internal static int Pixels(double css, int dpi) { return (int)Math.Round(css * dpi / 96.0, MidpointRounding.AwayFromZero); }
        internal static Rectangle DragBounds(int dpi) { return new Rectangle(Pixels(4, dpi), Pixels(2, dpi), Pixels(DragWidthCss, dpi), Pixels(DragHeightCss, dpi)); }
        internal static Rectangle ResizeBounds(Size size, int dpi) {
            int extent = Pixels(15, dpi);
            return new Rectangle(size.Width - extent, size.Height - extent, extent, extent);
        }
    }

    public static class TranslationProtocol
    {
        public static TranslationResult ParseLayout(string text)
        {
            try
            {
                text = text.Trim();
                if (text.StartsWith("```")) { int line = text.IndexOf('\n'); int end = text.LastIndexOf("```"); if (line >= 0 && end > line) text = text.Substring(line + 1, end - line - 1); }
                var root = new JavaScriptSerializer { MaxJsonLength = 2000000 }.Deserialize<Dictionary<string, object>>(text);
                var blocks = (ArrayList)root["blocks"];
                if (blocks.Count > 256) throw new ArgumentException("选区文字块过多，请缩小范围。");
                var result = new TranslationResult();
                foreach (Dictionary<string, object> block in blocks)
                {
                    var coordinates = (ArrayList)block["box"];
                    if (coordinates.Count != 4) throw new FormatException();
                    foreach (object coordinate in coordinates)
                        if (!(coordinate is int || coordinate is long || coordinate is decimal || coordinate is double)) throw new FormatException();
                    float left = Convert.ToSingle(coordinates[0]), top = Convert.ToSingle(coordinates[1]);
                    float right = Convert.ToSingle(coordinates[2]), bottom = Convert.ToSingle(coordinates[3]);
                    if (Single.IsNaN(left + top + right + bottom) || Single.IsInfinity(left + top + right + bottom) || left < 0 || top < 0 || right > 1000 || bottom > 1000 || right <= left || bottom <= top)
                        throw new ArgumentException("模型返回的文字位置不正确，请重试或更换视觉模型。");
                    var translated = block["text"] as string;
                    if (translated == null) throw new FormatException();
                    if (String.IsNullOrWhiteSpace(translated)) continue;
                    object bg, fg; block.TryGetValue("background", out bg); block.TryGetValue("foreground", out fg);
                    Color background = ParseColor(bg as string, Color.FromArgb(248, 250, 252));
                    Color foreground = ParseColor(fg as string, background.GetBrightness() > .5 ? Color.FromArgb(24, 32, 48) : Color.White);
                    if (Math.Abs(background.GetBrightness() - foreground.GetBrightness()) < .3) foreground = background.GetBrightness() > .5 ? Color.FromArgb(24, 32, 48) : Color.White;
                    result.Blocks.Add(new TranslationBlock { Box = new RectangleF(left, top, right - left, bottom - top), Text = translated, Background = background, Foreground = foreground });
                }
                return result;
            }
            catch (ArgumentException) { throw; }
            catch (Exception e) { if (e is OutOfMemoryException) throw; throw new ArgumentException("模型未返回文字定位数据，请使用支持视觉定位和 JSON 输出的模型后重试。"); }
        }
        static Color ParseColor(string input, Color fallback)
        {
            int rgb;
            if (input != null && input.Length == 7 && input[0] == '#' && Int32.TryParse(input.Substring(1), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out rgb)) return Color.FromArgb(255, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
            return fallback;
        }
    }

    public sealed class TranslationBlock { public RectangleF Box; public string Text; public Color Background, Foreground; }
    public sealed class TranslationResult
    {
        public List<TranslationBlock> Blocks = new List<TranslationBlock>();
        public string PlainText { get { return String.Join("\n", Blocks.ConvertAll(b => b.Text)); } }
    }

    public static class RegionalLayout
    {
        public static TranslationResult KeepOutside(TranslationResult source, IList<RectangleF> regions)
        {
            var result = new TranslationResult();
            if (source == null) return result;
            foreach (var block in source.Blocks)
            {
                bool changed = false;
                foreach (var region in regions) if (region.IntersectsWith(block.Box)) { changed = true; break; }
                if (!changed) result.Blocks.Add(block);
            }
            return result;
        }
        public static TranslationResult Map(TranslationResult source, RectangleF crop)
        {
            var result = new TranslationResult();
            foreach (var block in source.Blocks) result.Blocks.Add(new TranslationBlock {
                Box = new RectangleF(crop.X + block.Box.X * crop.Width / 1000f, crop.Y + block.Box.Y * crop.Height / 1000f, block.Box.Width * crop.Width / 1000f, block.Box.Height * crop.Height / 1000f),
                Text = block.Text, Background = block.Background, Foreground = block.Foreground
            });
            return result;
        }
    }

    public sealed class FrameFingerprint
    {
        byte[] pixels;
        int width, height, sourceWidth, sourceHeight;
        public static FrameFingerprint Create(Bitmap source)
        {
            double scale = Math.Min(1.0, 1024.0 / Math.Max(source.Width, source.Height));
            int width = Math.Max(1, (int)(source.Width * scale)), height = Math.Max(1, (int)(source.Height * scale));
            using (var sample = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(sample)) { g.DrawImage(source, new Rectangle(0, 0, width, height)); }
                var data = sample.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    var bytes = new byte[width * height * 3];
                    for (int y = 0; y < height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), bytes, y * width * 3, width * 3);
                    return new FrameFingerprint { pixels = bytes, width = width, height = height, sourceWidth = source.Width, sourceHeight = source.Height };
                }
                finally { sample.UnlockBits(data); }
            }
        }
        public bool Matches(FrameFingerprint other)
        {
            if (other == null || width != other.width || height != other.height || sourceWidth != other.sourceWidth || sourceHeight != other.sourceHeight) return false;
            int changed = 0;
            for (int i = 0; i < pixels.Length; i += 3)
            {
                int difference = Math.Abs(pixels[i] - other.pixels[i]) + Math.Abs(pixels[i+1] - other.pixels[i+1]) + Math.Abs(pixels[i+2] - other.pixels[i+2]);
                if (difference >= 36 && ++changed >= 8) return false;
            }
            return true;
        }
        public List<RectangleF> ChangedBands(FrameFingerprint other, TranslationResult known)
        {
            var full = new List<RectangleF> { new RectangleF(0, 0, 1000, 1000) };
            if (other == null || width != other.width || height != other.height || sourceWidth != other.sourceWidth || sourceHeight != other.sourceHeight) return full;
            bool[] rows = new bool[height]; int changed = 0;
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++)
            {
                int i = (y * width + x) * 3;
                int difference = Math.Abs(pixels[i] - other.pixels[i]) + Math.Abs(pixels[i+1] - other.pixels[i+1]) + Math.Abs(pixels[i+2] - other.pixels[i+2]);
                if (difference >= 36) { rows[y] = true; changed++; }
            }
            var bands = new List<RectangleF>();
            if (changed < 8) return bands;
            // Full-width bands retain complete new lines instead of cutting a changed
            // word out of its context. Add vertical context, then include whole old boxes.
            float margin = Math.Max(4, 12000f / sourceHeight);
            for (int y = 0; y < height; y++)
            {
                if (!rows[y]) continue;
                int start = y; while (y + 1 < height && rows[y+1]) y++;
                float top = Math.Max(0, start * 1000f / height - margin), bottom = Math.Min(1000, (y + 1) * 1000f / height + margin);
                bool expanded;
                do {
                    expanded = false;
                    if (known != null) foreach (var block in known.Blocks)
                    {
                        if (block.Box.Bottom <= top || block.Box.Top >= bottom) continue;
                        float nextTop = Math.Max(0, Math.Min(top, block.Box.Top - 3)), nextBottom = Math.Min(1000, Math.Max(bottom, block.Box.Bottom + 3));
                        if (nextTop != top || nextBottom != bottom) { top = nextTop; bottom = nextBottom; expanded = true; }
                    }
                } while (expanded);
                bands.Add(RectangleF.FromLTRB(0, top, 1000, bottom));
            }
            bands.Sort((a,b) => a.Top.CompareTo(b.Top));
            var merged = new List<RectangleF>();
            foreach (var band in bands)
            {
                if (merged.Count > 0 && merged[merged.Count-1].Bottom + margin >= band.Top) merged[merged.Count-1] = RectangleF.Union(merged[merged.Count-1], band);
                else merged.Add(band);
            }
            float total = 0; foreach (var band in merged) total += band.Height;
            return merged.Count > 4 || total >= 650 ? full : merged;
        }
    }

    public sealed class WorkItem<T> { public T Value; internal long Version; }
    // Accessed on the UI thread only. Reset invalidates active work but does not release its slot.
    public sealed class LatestWork<T>
    {
        long version;
        WorkItem<T> pending, active;
        public bool Busy { get { return active != null; } }
        public void Offer(T value) { pending = new WorkItem<T> { Value = value, Version = ++version }; }
        public WorkItem<T> Take()
        {
            if (active != null || pending == null) return null;
            active = pending; pending = null; return active;
        }
        public bool Complete(WorkItem<T> work)
        {
            if (!Object.ReferenceEquals(active, work) || work == null) return false;
            active = null; return work.Version == version;
        }
        public void Reset() { version++; pending = null; }
    }
}
