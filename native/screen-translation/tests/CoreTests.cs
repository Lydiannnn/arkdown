using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Web.Script.Serialization;
using Arkdown.ScreenTranslation;
class CoreTests
{
    static int failures;
    static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    static void Test(string name, Action action) { try { action(); Console.WriteLine("PASS: " + name); } catch (Exception e) { failures++; Console.WriteLine("FAIL: " + name + " - " + e.Message); } }
    static void Reject(Action action) { bool rejected = false; try { action(); } catch (ArgumentException) { rejected = true; } Check(rejected, "invalid input accepted"); }
    static int Main()
    {
        Test("translated blocks retain source coordinates", delegate { var r = TranslationProtocol.ParseLayout("{\"blocks\":[{\"box\":[100,200,600,320],\"text\":\"你好，世界\",\"background\":\"#ffffff\",\"foreground\":\"#101010\"}]}"); Check(r.Blocks.Count == 1 && r.Blocks[0].Box.X == 100 && r.Blocks[0].Box.Width == 500 && r.PlainText == "你好，世界", "in-place layout lost"); });
        Test("no-text image clears old blocks", delegate { Check(TranslationProtocol.ParseLayout("{\"blocks\":[]}").Blocks.Count == 0, "blank frame invented text"); });
        Test("out of bounds model boxes rejected", delegate { Reject(delegate { TranslationProtocol.ParseLayout("{\"blocks\":[{\"box\":[-200,0,800,1000],\"text\":\"x\"}]}"); }); });
        Test("identical screen needs no translation", delegate { using (var a = new Bitmap(320, 160)) { using (var g = Graphics.FromImage(a)) g.Clear(Color.White); Check(FrameFingerprint.Create(a).Matches(FrameFingerprint.Create(a)), "identical image changed"); } });
        Test("small changed text inside large screen is noticed", delegate { using (var a = new Bitmap(1200, 600)) using (var b = new Bitmap(1200, 600)) { using (var g = Graphics.FromImage(a)) g.Clear(Color.White); using (var g = Graphics.FromImage(b)) { g.Clear(Color.White); g.FillRectangle(Brushes.Black, 700, 350, 7, 15); } Check(!FrameFingerprint.Create(a).Matches(FrameFingerprint.Create(b)), "small content change ignored"); } });
        Test("pixel noise does not trigger a request", delegate { using (var a = new Bitmap(100, 100)) using (var b = new Bitmap(100, 100)) { using (var g = Graphics.FromImage(a)) g.Clear(Color.White); using (var g = Graphics.FromImage(b)) g.Clear(Color.FromArgb(253,253,253)); Check(FrameFingerprint.Create(a).Matches(FrameFingerprint.Create(b)), "tiny noise retriggered"); } });
        Test("request in flight blocks parallel work and discards stale response", delegate { var q = new LatestWork<string>(); q.Offer("a"); var a = q.Take(); q.Offer("b"); q.Offer("c"); Check(q.Take() == null, "parallel work started"); Check(!q.Complete(a), "stale result accepted"); var c = q.Take(); Check(c.Value == "c", "intermediate frame not dropped"); Check(q.Complete(c), "latest response not accepted"); Check(q.Take() == null, "duplicate request"); });
        Test("pause invalidates response without starting parallel work", delegate { var q = new LatestWork<string>(); q.Offer("a"); var a = q.Take(); q.Reset(); q.Offer("new target"); Check(q.Take() == null, "reset forgot active request"); Check(!q.Complete(a), "old target accepted"); var b = q.Take(); Check(b.Value == "new target" && q.Complete(b), "new target lost"); });
        Test("dirty band hides only changed text and covers its entire old box", delegate {
            using (var a = new Bitmap(600, 400)) using (var b = new Bitmap(600, 400)) {
                using (var g = Graphics.FromImage(a)) g.Clear(Color.White);
                using (var g = Graphics.FromImage(b)) { g.Clear(Color.White); g.FillRectangle(Brushes.Black, 50, 42, 30, 12); }
                var old = new TranslationResult();
                old.Blocks.Add(new TranslationBlock { Box = new RectangleF(50, 80, 750, 100), Text = "old first" });
                old.Blocks.Add(new TranslationBlock { Box = new RectangleF(50, 600, 750, 80), Text = "unchanged" });
                var bands = FrameFingerprint.Create(b).ChangedBands(FrameFingerprint.Create(a), old);
                Check(bands.Count == 1 && bands[0].Top <= 80 && bands[0].Bottom >= 180 && bands[0].Bottom < 600, "band clipped text or covered unchanged row");
                Check(RegionalLayout.KeepOutside(old, bands).PlainText == "unchanged", "unchanged translation lost or stale translation retained");
            }
        });
        Test("identical image has no dirty regions and resizing invalidates whole frame", delegate {
            using (var a = new Bitmap(600, 400)) using (var b = new Bitmap(601, 400)) {
                var fp = FrameFingerprint.Create(a);
                Check(fp.ChangedBands(fp, null).Count == 0, "unchanged image dirtied");
                Check(FrameFingerprint.Create(b).ChangedBands(fp, null)[0] == new RectangleF(0, 0, 1000, 1000), "resized frame reused stale position");
            }
        });
        Test("local crop coordinates map back into full frame", delegate {
            var crop = new TranslationResult(); crop.Blocks.Add(new TranslationBlock { Box = new RectangleF(100, 200, 500, 400), Text = "new" });
            var result = RegionalLayout.Map(crop, new RectangleF(0, 300, 1000, 200));
            Check(result.Blocks[0].Box == new RectangleF(100, 340, 500, 80), "crop result position not restored");
        });
        Console.WriteLine(failures == 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
        return failures == 0 ? 0 : 1;
    }
}
