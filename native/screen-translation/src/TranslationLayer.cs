using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace Arkdown.ScreenTranslation
{
    internal sealed class TranslationLayer : ProtectedForm
    {
        internal TranslationResult Result { get; private set; }
        internal TranslationLayer()
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
            BackColor = TransparencyKey = SurfaceTheme.Transparent; DoubleBuffered = true; AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.Manual;
        }
        protected override CreateParams CreateParams
        {
            get { var p = base.CreateParams; p.ExStyle |= 0x20 | 0x80000 | 0x08000000 | 0x80; return p; }
        }
        internal void SetResult(TranslationResult result) { Result = result; Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Result == null) return;
            e.Graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            // Color-keyed windows need hard pixel edges; anti-aliased masks blend with the key and leave dark outlines.
            e.Graphics.SmoothingMode = SmoothingMode.None;
            foreach (var block in Result.Blocks)
            {
                var rect = new RectangleF(block.Box.X * ClientSize.Width / 1000f, block.Box.Y * ClientSize.Height / 1000f, block.Box.Width * ClientSize.Width / 1000f, block.Box.Height * ClientSize.Height / 1000f);
                rect.Inflate(1, 1);
                rect = RectangleF.FromLTRB((float)Math.Floor(rect.Left), (float)Math.Floor(rect.Top), (float)Math.Ceiling(rect.Right), (float)Math.Ceiling(rect.Bottom));
                Color bg = block.Background.ToArgb() == SurfaceTheme.Transparent.ToArgb() ? Color.FromArgb(2, 3, 4) : block.Background;
                using (var brush = new SolidBrush(bg)) e.Graphics.FillRectangle(brush, rect);
                var textRect = rect; textRect.Inflate(-2, -1);
                if (textRect.Width < 2 || textRect.Height < 2) continue;
                using (var format = new StringFormat(StringFormat.GenericDefault))
                {
                    format.Trimming = StringTrimming.None;
                    foreach (char c in block.Text) { if (c >= 0x590 && c <= 0x8FF) { format.FormatFlags |= StringFormatFlags.DirectionRightToLeft; break; } if (Char.IsLetter(c)) break; }
                    float size = Math.Min(36, Math.Max(7, textRect.Height * .72f));
                    while (size > 7)
                    {
                        using (var font = SurfaceTheme.Font(size))
                        {
                            SizeF measure = e.Graphics.MeasureString(block.Text, font, new SizeF(textRect.Width, 10000), format);
                            if (measure.Height <= textRect.Height + 1) break;
                        }
                        size -= .5f;
                    }
                    using (var font = SurfaceTheme.Font(size))
                    using (var brush = new SolidBrush(block.Foreground)) e.Graphics.DrawString(block.Text, font, brush, textRect, format);
                }
            }
        }
    }
}
