using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;

namespace Arkdown.ScreenTranslation
{
    internal interface ITranslationSurface : IDisposable
    {
        Rectangle Bounds { get; }
        bool Adjusting { get; }
        event Action GeometryChanged;
        void Configure(Configuration configuration);
        void SetTheme(Dictionary<string, string> theme);
        Bitmap Capture();
        void Render(TranslationResult result, bool showOriginal);
    }

    // Deliberately separate the last successful source baseline from what is still visible.
    internal sealed class FrameHistory
    {
        internal FrameFingerprint Baseline;
        internal TranslationResult BaselineResult;
        internal TranslationResult Visible = new TranslationResult();
        internal void Reset() { Baseline = null; BaselineResult = null; }
        internal void Prepare(ScreenFrame frame)
        {
            var invalidatedRegions = frame.Fingerprint.ChangedBands(Baseline, BaselineResult);
            Visible = RegionalLayout.KeepOutside(Visible, invalidatedRegions);
            // No dirty region means a forced whole-frame request (Regions remains null),
            // but it does not invalidate any still-visible translation while waiting.
            bool partial = Baseline != null && invalidatedRegions.Count > 0 &&
                !(invalidatedRegions.Count == 1 && invalidatedRegions[0].Height >= 999);
            // Merge from the complete successful baseline. A previously withdrawn block
            // can now match the source again; it belongs in a successful new result,
            // even though it must remain withdrawn while that result is pending.
            if (partial) { frame.Regions = invalidatedRegions; frame.Preserved = RegionalLayout.KeepOutside(BaselineResult, invalidatedRegions); }
        }
        internal void Commit(ScreenFrame frame, TranslationResult result)
        {
            Baseline = frame.Fingerprint; BaselineResult = result; Visible = result;
        }
    }

    internal sealed class Controller : IDisposable
    {
        readonly ITranslationSurface surface;
        readonly TranslationBridge bridge;
        readonly Action<object> emit;
        readonly LatestWork<ScreenFrame> queue = new LatestWork<ScreenFrame>();
        readonly FrameHistory history = new FrameHistory();
        readonly Func<Bitmap, Task<ScreenFrame>> encode;
        Configuration configuration = new Configuration();
        CancellationTokenSource active;
        FrameFingerprint previous;
        bool automatic, showOriginal, manualPending, sampling, disposed, configuring;
        long generation;
        int failures;
        DateTime nextAttempt = DateTime.MinValue, requestStarted;
        string status = "已暂停，拖动取景框后翻译。", error;
        internal bool Busy { get { return queue.Busy; } }
        internal bool Sampling { get { return sampling; } }
        internal bool Automatic { get { return automatic; } }
        internal TranslationResult Visible { get { return history.Visible; } }

        internal Controller(ITranslationSurface surface, Action<object> emit, Func<Bitmap, Task<ScreenFrame>> encode = null)
        {
            this.surface = surface; this.emit = emit;
            this.encode = encode ?? (bitmap => Task.Run(() => ScreenCapture.Encode(bitmap)));
            bridge = new TranslationBridge(emit);
            surface.GeometryChanged += GeometryChanged;
        }

        internal void Handle(Command command)
        {
            if (disposed) return;
            switch (command.Type) {
                case "configure":
                    // Configuration never implicitly resumes capture, including after a helper restart.
                    automatic = false; Invalidate(true);
                    configuring = true;
                    try { surface.Configure(command.Configuration); configuration = command.Configuration; }
                    finally { configuring = false; }
                    history.Visible = new TranslationResult(); Render();
                    SetStatus("已暂停，配置已更新。", null); break;
                case "mode":
                    automatic = false; Invalidate(false); configuration.TriggerMode = command.Mode;
                    SetStatus(command.Mode == "hotkey" ? "快捷键模式，等待翻译。" : "自动模式已暂停。", null); break;
                case "automatic":
                    automatic = command.Flag; Invalidate(false);
                    if (automatic) configuration.TriggerMode = "automatic";
                    SetStatus(automatic ? "每秒检查画面变化。" : "已暂停，保留当前译文。", null);
                    if (automatic) Sample(); break;
                case "once":
                    Invalidate(false); manualPending = true;
                    SetStatus("正在读取选区……", null); Sample(); break;
                case "clear":
                    automatic = false; Invalidate(true); showOriginal = false;
                    history.Visible = new TranslationResult(); Render();
                    SetStatus("译文已清除，等待再次翻译。", null); break;
                case "original": showOriginal = command.Flag; Render(); State(); break;
                case "theme": surface.SetTheme(command.Theme); Render(); State(); break;
                case "result": bridge.Receive(command); break;
            }
        }

        internal void Tick()
        {
            if (disposed) return;
            if (queue.Busy && DateTime.UtcNow - requestStarted > TimeSpan.FromSeconds(90)) bridge.Expire();
            Sample();
        }
        internal void ReportError(string message) { if (!disposed) SetStatus(message, message); }
        void Invalidate(bool baseline)
        {
            generation++; queue.Reset(); previous = null; manualPending = false;
            if (baseline) history.Reset();
            if (active != null) active.Cancel();
            nextAttempt = DateTime.MinValue; failures = 0;
        }
        void GeometryChanged()
        {
            if (disposed || configuring) return;
            Invalidate(true);
            if (automatic) history.Visible = new TranslationResult();
            Render();
            SetStatus(automatic ? "选区已改变，等待画面稳定。" : "选区已改变，等待翻译。", null);
        }
        async void Sample()
        {
            if (disposed || sampling || (!automatic && !manualPending) || surface.Adjusting || DateTime.UtcNow < nextAttempt) return;
            sampling = true; long sampleGeneration = generation;
            try {
                ScreenFrame frame;
                using (var bitmap = surface.Capture()) frame = await encode(bitmap);
                if (disposed || sampleGeneration != generation) return;
                bool force = manualPending; manualPending = false;
                if (force || previous == null || !frame.Fingerprint.Matches(previous)) {
                    history.Prepare(frame); Render();
                    previous = frame.Fingerprint; queue.Offer(frame);
                    // Automatic samples replace only pending work. Let the active request
                    // finish, discard its stale response, then execute the latest sample.
                    State();
                }
                StartNext();
            } catch (Exception exception) {
                if (!disposed && sampleGeneration == generation) {
                    manualPending = false; previous = null; nextAttempt = DateTime.UtcNow.AddSeconds(5);
                    SetStatus(exception is ArgumentException ? exception.Message : "暂时无法读取屏幕，请检查选区。", "capture-failed");
                }
            } finally {
                sampling = false;
                if (!disposed) State();
                // A once command received during encoding must not be swallowed.
                if (!disposed && manualPending && sampleGeneration != generation) Sample();
            }
        }
        async void StartNext()
        {
            if (disposed) return;
            var work = queue.Take(); if (work == null) return;
            Configuration snapshot = configuration;
            var cancellation = new CancellationTokenSource(); active = cancellation;
            requestStarted = DateTime.UtcNow;
            TranslationResult result = null; Exception failure = null;
            SetStatus("正在翻译为" + snapshot.Target + "……", null);
            try {
                if (work.Value.Regions == null) result = await bridge.Translate(snapshot, work.Value.Base64, cancellation.Token);
                else {
                    result = new TranslationResult(); result.Blocks.AddRange(work.Value.Preserved.Blocks);
                    var crops = await Task.Run(() => ScreenCapture.Crop(work.Value), cancellation.Token);
                    foreach (var crop in crops) {
                        var local = await bridge.Translate(snapshot, crop.Base64, cancellation.Token);
                        result.Blocks.AddRange(RegionalLayout.Map(local, crop.Bounds).Blocks);
                    }
                    result.Blocks.Sort((a,b) => { int row = a.Box.Top.CompareTo(b.Box.Top); return row == 0 ? a.Box.Left.CompareTo(b.Box.Left) : row; });
                }
                if (result.Blocks.Count > 256 || System.Text.Encoding.UTF8.GetByteCount(Wire.Json().Serialize(Wire.Layout(result))) > Wire.MaxResultBytes) throw new ArgumentException("选区译文过多，请缩小范围。");
            } catch (Exception exception) { failure = exception; }
            bool current = queue.Complete(work);
            if (Object.ReferenceEquals(active, cancellation)) active = null;
            cancellation.Dispose();
            if (disposed) return;
            if (current && failure == null) {
                history.Commit(work.Value, result); Render(); failures = 0; nextAttempt = DateTime.MinValue;
                SetStatus(result.Blocks.Count == 0 ? "选区中没有可识别的文字。" : "译文已更新。", null);
            } else if (current && !(failure is OperationCanceledException)) {
                previous = null;
                var service = failure as TranslationException;
                if (service != null && service.NeedsSettings) { automatic = false; Invalidate(false); }
                failures++; nextAttempt = DateTime.UtcNow.AddSeconds(Math.Min(60, 5 * Math.Pow(2, Math.Min(failures - 1, 4))));
                string message = failure is ArgumentException || service != null ? failure.Message : "翻译未完成，请重试。";
                SetStatus(message, message);
            } else State();
            StartNext();
        }
        void Render() { surface.Render(history.Visible, showOriginal); }
        void SetStatus(string value, string failure) { status = value; error = failure; State(); }
        internal void State()
        {
            var bounds = surface.Bounds;
            emit(new { type = "state", automatic = automatic, triggerMode = configuration.TriggerMode,
                busy = queue.Busy || sampling, showOriginal = showOriginal,
                bounds = new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height },
                result = Wire.Layout(history.Visible), error = error, status = status });
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; automatic = false; generation++; queue.Reset();
            if (active != null) active.Cancel();
            bridge.Dispose(); surface.GeometryChanged -= GeometryChanged; surface.Dispose();
        }
    }
}
