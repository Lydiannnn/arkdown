using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace Arkdown.ScreenTranslation
{
    internal sealed class ScreenFrame
    {
        internal string Base64;
        internal FrameFingerprint Fingerprint;
        internal List<RectangleF> Regions { get; set; }
        internal TranslationResult Preserved { get; set; }
    }
    internal sealed class FrameCrop
    {
        internal string Base64;
        internal RectangleF Bounds;
    }
    internal static class ScreenCapture
    {
        internal static List<FrameCrop> Crop(ScreenFrame frame)
        {
            var crops = new List<FrameCrop>();
            using (var stream = new MemoryStream(Convert.FromBase64String(frame.Base64)))
            using (var image = new Bitmap(stream))
            foreach (var region in frame.Regions)
            {
                int left = Math.Max(0, (int)Math.Floor(region.Left * image.Width / 1000f));
                int top = Math.Max(0, (int)Math.Floor(region.Top * image.Height / 1000f));
                int right = Math.Min(image.Width, (int)Math.Ceiling(region.Right * image.Width / 1000f));
                int bottom = Math.Min(image.Height, (int)Math.Ceiling(region.Bottom * image.Height / 1000f));
                var bounds = Rectangle.FromLTRB(left, top, right, bottom);
                using (var crop = image.Clone(bounds, PixelFormat.Format24bppRgb))
                using (var png = new MemoryStream())
                {
                    crop.Save(png, ImageFormat.Png);
                    crops.Add(new FrameCrop { Base64 = Convert.ToBase64String(png.ToArray()), Bounds = new RectangleF(left * 1000f / image.Width, top * 1000f / image.Height, bounds.Width * 1000f / image.Width, bounds.Height * 1000f / image.Height) });
                }
            }
            return crops;
        }
        internal static ScreenFrame Encode(Bitmap bitmap)
        {
            var fingerprint = FrameFingerprint.Create(bitmap);
            double scale = Math.Min(1.0, 2400.0 / Math.Max(bitmap.Width, bitmap.Height));
            using (var png = new MemoryStream())
            {
                if (scale < 1)
                {
                    using (var small = new Bitmap(Math.Max(1, (int)(bitmap.Width * scale)), Math.Max(1, (int)(bitmap.Height * scale))))
                    {
                        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(bitmap, 0, 0, small.Width, small.Height); }
                        small.Save(png, ImageFormat.Png);
                    }
                }
                else bitmap.Save(png, ImageFormat.Png);
                return new ScreenFrame { Fingerprint = fingerprint, Base64 = Convert.ToBase64String(png.ToArray()) };
            }
        }
    }
}
