using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Arkdown.ScreenTranslation;

class ProtocolTests
{
    static int failures;
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Test(string name, Action action) { try { action(); Console.WriteLine("PASS: " + name); } catch (Exception exception) { failures++; Console.WriteLine("FAIL: " + name + " - " + exception); } }
    static void Reject(string json) { try { Command.Parse(json); } catch (ArgumentException) { return; } throw new Exception("invalid command accepted"); }
    static Command Parse(string json) { return Command.Parse(json); }
    internal sealed class Pump : SynchronizationContext
    {
        readonly ConcurrentQueue<Action> work = new ConcurrentQueue<Action>();
        public override void Post(SendOrPostCallback callback, object state) { work.Enqueue(() => callback(state)); }
        internal void Drain() { Action action; while (work.TryDequeue(out action)) action(); }
        internal void Until(Func<bool> condition) {
            DateTime limit = DateTime.UtcNow.AddSeconds(5);
            while (!condition()) { Drain(); if (DateTime.UtcNow > limit) throw new Exception("async test timeout"); Thread.Sleep(1); }
            Drain();
        }
    }
    sealed class FakeSurface : ITranslationSurface
    {
        internal int Captures, Revision;
        internal bool Disposed;
        internal TranslationResult Result;
        internal bool Original;
        internal Rectangle CurrentBounds = new Rectangle(-1200, -40, 600, 400), RenderedBounds;
        public Rectangle Bounds { get { return CurrentBounds; } }
        public bool Adjusting { get { return false; } }
        public event Action GeometryChanged;
        public void Configure(Configuration configuration) { }
        public void SetTheme(Dictionary<string,string> theme) { }
        public Bitmap Capture() {
            Captures++;
            var bitmap = new Bitmap(600, 400);
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.Clear(Color.White);
                if (Revision == 1 || Revision == 2) graphics.FillRectangle(Brushes.Black, 50, 42, 30, 12);
                if (Revision > 1) graphics.FillRectangle(Brushes.Black, 50, 270, 30, 12);
            }
            return bitmap;
        }
        public void Move() { CurrentBounds = new Rectangle(-1100, -20, 650, 420); if (GeometryChanged != null) GeometryChanged(); }
        public void Render(TranslationResult result, bool showOriginal) { Result = result; Original = showOriginal; RenderedBounds = Bounds; }
        public void Dispose() { Disposed = true; }
    }
    sealed class Harness : IDisposable
    {
        internal readonly Pump Context = new Pump();
        internal readonly FakeSurface Surface = new FakeSurface();
        internal readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
        internal readonly Controller Controller;
        readonly SynchronizationContext previous;
        internal Harness(Func<Bitmap, Task<ScreenFrame>> encode = null) {
            previous = SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(Context);
            Controller = new Controller(Surface, value => Events.Add(Wire.Json().Deserialize<Dictionary<string, object>>(Wire.Json().Serialize(value))), encode ?? (bitmap => Task.FromResult(ScreenCapture.Encode(bitmap))));
        }
        internal int Requests { get { return Events.FindAll(item => (string)item["type"] == "request").Count; } }
        internal int Cancels { get { return Events.FindAll(item => (string)item["type"] == "cancel").Count; } }
        internal long LastId { get { return Convert.ToInt64(Events.FindLast(item => (string)item["type"] == "request")["id"]); } }
        internal void Send(string json) { Controller.Handle(Parse(json)); }
        internal void Reply(string blocks) { Send("{\"type\":\"result\",\"id\":" + LastId + ",\"result\":{\"blocks\":" + blocks + "}}"); Context.Until(() => !Controller.Busy); }
        public void Dispose() { Controller.Dispose(); Context.Drain(); SynchronizationContext.SetSynchronizationContext(previous); }
    }
    const string TwoBlocks = "[{\"box\":[50,80,800,180],\"text\":\"first\"},{\"box\":[50,600,800,760],\"text\":\"second\"}]";
    static int Main()
    {
        Test("drag enlargement and resize hit target scale with per-window DPI", delegate {
            Check(Math.Abs(OverlayMetrics.DragWidthCss * 1.5 - 132 * 1.3) < .001 && Math.Abs(OverlayMetrics.DragHeightCss * 1.5 - 23 * 1.3) < .001, "header is not enlarged by 30 percent");
            foreach (int dpi in new int[] { 96, 120, 144, 192 }) {
                var grip = OverlayMetrics.ResizeBounds(new Size(800, 600), dpi);
                int extent = (int)Math.Round(15 * dpi / 96.0, MidpointRounding.AwayFromZero);
                Check(grip.Width == extent && grip.Height == extent && grip.Right == 800 && grip.Bottom == 600, "resize target did not follow DPI");
                Check(grip.Contains(new Point(grip.Left, grip.Top)) && !grip.Contains(new Point(grip.Left - 1, grip.Top)), "resize boundary drift");
                var drag = OverlayMetrics.DragBounds(dpi);
                Check(drag.Height + drag.Top < OverlayMetrics.Pixels(26, dpi), "header overlaps capture area");
            }
            Check(OverlayMetrics.ResizeBounds(new Size(800, 600), 144).Width == 23, "150 percent target must round 22.5 to 23 physical pixels");
            Check(OverlayMetrics.DragBounds(144).Size == new Size(172, 30), "150 percent drag target must be 172 x 30 physical pixels");
        });
        Test("strict configure defaults and negative physical bounds", delegate {
            var configuration = Parse("{\"type\":\"configure\",\"backend\":\"model\",\"target\":\"日本語\",\"triggerMode\":\"hotkey\",\"bounds\":{\"x\":-1920,\"y\":-200,\"width\":600,\"height\":280},\"excludedWindowHandles\":[\"1234\"]}").Configuration;
            Check(configuration.Bounds.Value.X == -1920 && configuration.Backend == "model" && configuration.Target == "日本語", "configuration changed");
            Check(Command.Parse("{\"type\":\"configure\",\"backend\":\"baidu\",\"target\":\"auto\",\"triggerMode\":\"automatic\"}").Configuration.Target == "auto", "automatic target rejected before host OCR resolution");
            Reject("{\"type\":\"automatic\",\"enabled\":\"false\"}");
            Reject("{\"type\":\"mode\",\"mode\":\"timer\"}");
            Reject("{\"type\":\"shell\",\"command\":\"anything\"}");
            Reject("{\"type\":\"result\",\"id\":1.5,\"result\":{\"blocks\":[]}}");
            Reject("{\"type\":\"result\",\"id\":1,\"result\":{\"blocks\":[{\"box\":[true,0,100,100],\"text\":\"x\"}]}}");
            Reject("{\"type\":\"result\",\"id\":1,\"result\":{\"blocks\":[{\"box\":[0,0,100,100],\"text\":null}]}}");
        });
        Test("UTF8 BOM, framing, empty result and EOF partial record", delegate {
            var lines = new List<string>();
            using (var input = new MemoryStream(Encoding.UTF8.GetBytes("\uFEFF{\"type\":\"once\"}\r\n{\"type\":\"original\",\"show\":true}\npartial"))) Wire.ReadLines(input, lines.Add);
            Check(lines.Count == 2 && Parse(lines[0]).Type == "once" && Parse(lines[1]).Flag, "UTF8 framing failed");
            Check(Parse("{\"type\":\"result\",\"id\":1,\"result\":{\"blocks\":[]}}").Result.Blocks.Count == 0, "empty result invalid");
        });
        Test("line and result byte limits reject before unbounded growth", delegate {
            using (var input = new MemoryStream(new byte[Wire.MaxLineBytes + 1])) {
                bool rejected = false;
                try { Wire.ReadLines(input, line => { }); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "unbounded line accepted");
            }
            Reject("{\"type\":\"result\",\"id\":1,\"result\":{\"blocks\":[{\"box\":[0,0,100,100],\"text\":\"" + new string('中', 700000) + "\"}]}}");
        });
        Test("bridge retains target, cancels once and ignores late response", delegate {
            var events = new List<Dictionary<string, object>>();
            using (var bridge = new TranslationBridge(value => events.Add(Wire.Json().Deserialize<Dictionary<string, object>>(Wire.Json().Serialize(value)))))
            using (var cancellation = new CancellationTokenSource()) {
                var task = bridge.Translate(new Configuration { Target = "Français", Backend = "model" }, "aW1hZ2U=", cancellation.Token);
                Check((string)events[0]["target"] == "Français" && (string)events[0]["backend"] == "model", "request mutated");
                cancellation.Cancel();
                bridge.Receive(Parse("{\"type\":\"result\",\"id\":1,\"result\":{\"blocks\":[]}}"));
                try { task.GetAwaiter().GetResult(); } catch (OperationCanceledException) { }
                Check(task.IsCanceled && bridge.PendingCount == 0 && events.Count == 2, "late result survived cancel");
            }
        });
        Test("bridge timeout cancels and next request can recover", delegate {
            using (var bridge = new TranslationBridge(value => { })) {
                var first = bridge.Translate(new Configuration(), "x", CancellationToken.None); bridge.Expire();
                try { first.GetAwaiter().GetResult(); } catch (TranslationException) { }
                Check(first.IsFaulted, "timeout did not fail");
                var second = bridge.Translate(new Configuration(), "x", CancellationToken.None);
                bridge.Receive(Parse("{\"type\":\"result\",\"id\":2,\"result\":{\"blocks\":[]}}"));
                Check(second.GetAwaiter().GetResult().Blocks.Count == 0, "recovery failed");
            }
        });
        Test("bridge disposal completes outstanding requests without a result", delegate {
            var bridge = new TranslationBridge(value => { });
            var task = bridge.Translate(new Configuration(), "x", CancellationToken.None);
            bridge.Dispose();
            try { task.GetAwaiter().GetResult(); } catch (OperationCanceledException) { }
            Check(task.IsCanceled && bridge.PendingCount == 0, "dispose left an unresolved response");
        });
        Test("controller starts paused and switching modes never captures", delegate {
            using (var harness = new Harness()) {
                harness.Controller.Tick();
                harness.Send("{\"type\":\"mode\",\"mode\":\"automatic\"}"); harness.Controller.Tick();
                Check(!harness.Controller.Automatic && harness.Surface.Captures == 0, "default/mode activated capture");
                harness.Send("{\"type\":\"once\"}");
                Check(harness.Requests == 1 && harness.Controller.Busy, "once did not run");
                harness.Reply(TwoBlocks);
                harness.Send("{\"type\":\"original\",\"show\":true}");
                Check(harness.Surface.Original && harness.Controller.Visible.Blocks.Count == 2, "original toggle lost result");
                harness.Send("{\"type\":\"automatic\",\"enabled\":false}");
                Check(harness.Controller.Visible.Blocks.Count == 2, "pause lost result");
            }
        });
        Test("clear during capture ignores late encoding failure and can translate again", delegate {
            var encoding = new TaskCompletionSource<ScreenFrame>();
            int calls = 0;
            using (var harness = new Harness(bitmap => ++calls == 1 ? encoding.Task : Task.FromResult(ScreenCapture.Encode(bitmap)))) {
                harness.Send("{\"type\":\"once\"}");
                harness.Send("{\"type\":\"clear\"}");
                encoding.SetException(new ArgumentException("stale capture error"));
                harness.Context.Until(() => !harness.Controller.Sampling);
                var state = harness.Events.FindLast(item => (string)item["type"] == "state");
                Check(state["error"] == null && harness.Requests == 0, "late encoding failure replaced clear state");
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                Check(harness.Controller.Visible.Blocks.Count == 2, "late failure blocked fresh translation");
            }
        });
        Test("clear cancels active and pending work, ignores late result and translates again", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                var bounds = harness.Surface.Bounds;
                harness.Send("{\"type\":\"automatic\",\"enabled\":true}");
                long oldId = harness.LastId;
                harness.Surface.Revision = 1; harness.Controller.Tick();
                harness.Send("{\"type\":\"clear\"}");
                Check(harness.Controller.Visible.Blocks.Count == 0 && !harness.Controller.Automatic, "clear retained text or automatic sampling");
                Check(harness.Surface.Bounds == bounds && !harness.Surface.Disposed, "clear closed or changed frame");
                harness.Context.Until(() => !harness.Controller.Busy);
                harness.Send("{\"type\":\"result\",\"id\":" + oldId + ",\"result\":{\"blocks\":" + TwoBlocks + "}}");
                harness.Controller.Tick(); harness.Context.Drain();
                Check(harness.Controller.Visible.Blocks.Count == 0 && harness.Requests == 2 && harness.Cancels == 1, "late or pending work refilled cleared result");
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                Check(harness.Controller.Visible.Blocks.Count == 2 && harness.Requests == 3, "clear prevented new translation");
            }
        });
        Test("cancelled active slot remains busy until callback; only newest request starts", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"once\"}"); long first = harness.LastId;
                harness.Send("{\"type\":\"once\"}"); harness.Send("{\"type\":\"once\"}");
                Check(harness.Requests == 1 && harness.Controller.Busy, "reset released active slot");
                harness.Context.Until(() => harness.Requests == 2);
                harness.Send("{\"type\":\"result\",\"id\":" + first + ",\"result\":{\"blocks\":" + TwoBlocks + "}}");
                Check(harness.Controller.Visible.Blocks.Count == 0, "stale response visible");
                harness.Reply("[]");
                Check(harness.Requests == 2 && harness.Cancels == 1, "intermediate pending request ran");
            }
        });
        foreach (string backend in new string[] { "baidu", "model" }) {
            Test(backend + " partial update removes stale text before request and failure never refills", delegate {
                using (var harness = new Harness()) {
                    harness.Send("{\"type\":\"configure\",\"backend\":\"" + backend + "\",\"target\":\"简体中文\",\"triggerMode\":\"automatic\"}");
                    harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                    harness.Surface.Revision = 1; harness.Send("{\"type\":\"once\"}");
                    Check(harness.Controller.Visible.PlainText == "second", "stale text not removed synchronously");
                    harness.Context.Until(() => harness.Requests == 2);
                    var request = harness.Events.FindLast(item => (string)item["type"] == "request");
                    using (var memory = new MemoryStream(Convert.FromBase64String((string)request["image"]))) using (var crop = new Bitmap(memory)) Check(crop.Height < 300, "partial frame became full capture");
                    harness.Send("{\"type\":\"result\",\"id\":" + harness.LastId + ",\"error\":\"test failure\"}");
                    harness.Context.Until(() => !harness.Controller.Busy);
                    Check(harness.Controller.Visible.PlainText == "second", "failure resurrected stale text");
                    harness.Send("{\"type\":\"automatic\",\"enabled\":false}");
                    Check(harness.Controller.Visible.PlainText == "second", "pause resurrected stale text");
                    harness.Surface.Revision = 0; harness.Send("{\"type\":\"once\"}");
                    harness.Context.Until(() => harness.Requests == 3);
                    Check(harness.Controller.Visible.PlainText == "second", "unchanged refresh removed valid visible text or restored withdrawn text prematurely");
                    harness.Reply("[]");
                }
            });
        }
        Test("move invalidates geometry; settings failure stops automatic; dispose cancels", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"automatic\",\"enabled\":true}");
                harness.Send("{\"type\":\"result\",\"id\":" + harness.LastId + ",\"error\":\"configure backend\",\"needsSettings\":true}");
                harness.Context.Until(() => !harness.Controller.Busy);
                Check(!harness.Controller.Automatic, "configuration error did not pause");
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks); harness.Surface.Move();
                Check(harness.Controller.Visible.PlainText == "first\nsecond", "paused movement lost retained translations");
                harness.Send("{\"type\":\"once\"}"); harness.Controller.Dispose(); harness.Context.Drain();
                Check(harness.Surface.Disposed && harness.Cancels == 1, "dispose left windows/tasks");
            }
        });
        foreach (string backend in new string[] { "baidu", "model" }) foreach (bool failed in new bool[] { true, false }) {
            Test(backend + " reverted region survives successful partial merge after " + (failed ? "failure" : "cancellation"), delegate {
                using (var harness = new Harness()) {
                    harness.Send("{\"type\":\"configure\",\"backend\":\"" + backend + "\",\"target\":\"简体中文\",\"triggerMode\":\"automatic\"}");
                    harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks); // A0+B0 baseline
                    harness.Surface.Revision = 1; harness.Send("{\"type\":\"once\"}"); // A1+B0 withdraws A
                    harness.Context.Until(() => harness.Requests == 2);
                    Check(harness.Controller.Visible.PlainText == "second", "changed A was not withdrawn");
                    if (failed) {
                        harness.Send("{\"type\":\"result\",\"id\":" + harness.LastId + ",\"error\":\"synthetic failure\"}");
                        harness.Context.Until(() => !harness.Controller.Busy);
                    }
                    harness.Surface.Revision = 3; harness.Send("{\"type\":\"once\"}"); // A0+B1: only B differs from baseline
                    harness.Context.Until(() => harness.Requests == 3);
                    Check(harness.Controller.Visible.Blocks.Count == 0, "withdrawn A reappeared before successful response");
                    harness.Reply("[{\"box\":[50,200,800,700],\"text\":\"second-new\"}]");
                    Check(harness.Controller.Visible.PlainText == "first\nsecond-new", "matching baseline A was permanently omitted from successful result");
                    harness.Surface.Revision = 2; harness.Send("{\"type\":\"once\"}"); // A1+B1: next baseline must retain both blocks
                    harness.Context.Until(() => harness.Requests == 4);
                    Check(harness.Controller.Visible.PlainText == "second-new", "successful baseline lost unchanged B");
                    harness.Reply("[{\"box\":[50,200,800,700],\"text\":\"first-new\"}]");
                    Check(harness.Controller.Visible.PlainText == "first-new\nsecond-new", "complete baseline was not preserved across follow-up crop");
                }
            });
        }
        Test("paused move and resize preserves visible layout, automatic movement clears it", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                var original = harness.Controller.Visible;
                harness.Surface.Move();
                Check(Object.ReferenceEquals(original, harness.Controller.Visible), "paused move discarded visible layout");
                Check(harness.Surface.RenderedBounds == harness.Surface.CurrentBounds && harness.Surface.Result.PlainText == "first\nsecond", "paused layout did not follow capture geometry");
                harness.Send("{\"type\":\"once\"}");
                var request = harness.Events.FindLast(item => (string)item["type"] == "request");
                using (var memory = new MemoryStream(Convert.FromBase64String((string)request["image"]))) using (var image = new Bitmap(memory)) Check(image.Height == 400, "move reused an invalid partial baseline");
                harness.Reply(TwoBlocks);
                harness.Send("{\"type\":\"automatic\",\"enabled\":true}");
                harness.Reply(TwoBlocks);
                harness.Surface.Move();
                Check(harness.Controller.Visible.Blocks.Count == 0, "automatic movement retained stale layout");
            }
        });
        Test("automatic changes replace only pending work and do not restart the active request", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"automatic\",\"enabled\":true}");
                long activeId = harness.LastId;
                harness.Surface.Revision = 1; harness.Controller.Tick();
                harness.Surface.Revision = 2; harness.Controller.Tick();
                harness.Context.Drain();
                Check(harness.Cancels == 0 && harness.Requests == 1 && harness.Controller.Busy, "automatic sampling cancelled/restarted active work");
                harness.Send("{\"type\":\"result\",\"id\":" + activeId + ",\"result\":{\"blocks\":" + TwoBlocks + "}}");
                harness.Context.Until(() => harness.Requests == 2);
                Check(harness.Controller.Visible.Blocks.Count == 0, "stale active result was displayed");
                var request = harness.Events.FindLast(item => (string)item["type"] == "request");
                using (var memory = new MemoryStream(Convert.FromBase64String((string)request["image"]))) using (var latest = new Bitmap(memory)) Check(latest.GetPixel(55, 275).R == 0, "intermediate pending image ran instead of newest frame");
                harness.Reply(TwoBlocks);
                Check(harness.Requests == 2 && harness.Cancels == 0, "automatic pending work duplicated or cancelled");
                harness.Send("{\"type\":\"automatic\",\"enabled\":false}");
            }
        });
        Test("manual unchanged refresh preserves valid visible text during failure and pause", delegate {
            using (var harness = new Harness()) {
                harness.Send("{\"type\":\"once\"}"); harness.Reply(TwoBlocks);
                harness.Send("{\"type\":\"once\"}");
                Check(harness.Controller.Visible.PlainText == "first\nsecond", "unchanged manual refresh withdrew valid layout");
                var request = harness.Events.FindLast(item => (string)item["type"] == "request");
                using (var memory = new MemoryStream(Convert.FromBase64String((string)request["image"]))) using (var image = new Bitmap(memory)) Check(image.Height == 400, "unchanged manual refresh did not request whole frame");
                harness.Send("{\"type\":\"result\",\"id\":" + harness.LastId + ",\"error\":\"synthetic failure\"}");
                harness.Context.Until(() => !harness.Controller.Busy);
                Check(harness.Controller.Visible.PlainText == "first\nsecond", "failed unchanged refresh cleared visible text");
                harness.Send("{\"type\":\"once\"}");
                harness.Send("{\"type\":\"automatic\",\"enabled\":false}"); harness.Context.Until(() => !harness.Controller.Busy);
                Check(harness.Controller.Visible.PlainText == "first\nsecond", "pause during unchanged refresh cleared valid layout");
            }
        });
        Test("rounded crop maps exact integer pixel bounds", delegate {
            using (var bitmap = new Bitmap(601, 403)) {
                var frame = ScreenCapture.Encode(bitmap);
                frame.Regions = new List<RectangleF> { RectangleF.FromLTRB(0, 101.1f, 1000, 187.4f) };
                var crop = ScreenCapture.Crop(frame)[0];
                int top = (int)Math.Floor(101.1f * 403 / 1000f), bottom = (int)Math.Ceiling(187.4f * 403 / 1000f);
                Check(Math.Abs(crop.Bounds.Top - top * 1000f / 403) < .001 && Math.Abs(crop.Bounds.Height - (bottom - top) * 1000f / 403) < .001, "fractional crop mapping drifted");
            }
        });
        Console.WriteLine(failures == 0 ? "ALL PROTOCOL/CONTROLLER TESTS PASSED" : failures + " TEST(S) FAILED");
        return failures == 0 ? 0 : 1;
    }
}
