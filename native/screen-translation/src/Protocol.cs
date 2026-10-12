using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Arkdown.ScreenTranslation
{
    internal sealed class Configuration
    {
        internal string Backend = "baidu", Target = "简体中文", TriggerMode = "hotkey", FontPath;
        internal Rectangle? Bounds;
        internal Dictionary<string, string> Theme;
        internal List<IntPtr> ExcludedWindowHandles = new List<IntPtr>();
    }

    internal sealed class Command
    {
        internal string Type, Mode, Error;
        internal bool Flag, NeedsSettings;
        internal long Id;
        internal Configuration Configuration;
        internal TranslationResult Result;
        internal Dictionary<string, string> Theme;

        internal static Command Parse(string line)
        {
            if (Encoding.UTF8.GetByteCount(line) > Wire.MaxLineBytes) throw new ArgumentException("Command exceeds 32 MB.");
            var root = Wire.Json().Deserialize<Dictionary<string, object>>(line.TrimStart('\uFEFF'));
            if (root == null) throw new ArgumentException("Expected a command object.");
            var command = new Command { Type = Text(root, "type", 32) };
            switch (command.Type)
            {
                case "configure":
                    var config = new Configuration {
                        Backend = Choice(root, "backend", "baidu", "model"),
                        Target = Text(root, "target", 64),
                        TriggerMode = Choice(root, "triggerMode", "automatic", "hotkey")
                    };
                    // The host resolves auto from the complete local OCR result.
                    if (root.ContainsKey("bounds")) {
                        var bounds = root["bounds"] as Dictionary<string, object>;
                        if (bounds == null) throw new ArgumentException("Invalid physical bounds.");
                        int x = Integer(bounds, "x", -100000, 100000), y = Integer(bounds, "y", -100000, 100000);
                        int width = Integer(bounds, "width", 80, 20000), height = Integer(bounds, "height", 40, 20000);
                        if ((long)width * height > 20000000) throw new ArgumentException("Selection exceeds 20 million pixels.");
                        config.Bounds = new Rectangle(x, y, width, height);
                    }
                    if (root.ContainsKey("theme")) config.Theme = ParseTheme(root["theme"]);
                    if (root.ContainsKey("fontPath")) {
                        config.FontPath = Text(root, "fontPath", 32767);
                        if (!Path.IsPathRooted(config.FontPath)) throw new ArgumentException("fontPath must be absolute.");
                    }
                    if (root.ContainsKey("excludedWindowHandles")) {
                        var handles = root["excludedWindowHandles"] as ArrayList;
                        if (handles == null || handles.Count > 32) throw new ArgumentException("Invalid excludedWindowHandles.");
                        foreach (object value in handles) {
                            long handle;
                            if (!(value is string) || !Int64.TryParse((string)value, out handle) || handle == 0) throw new ArgumentException("Window handles must be nonzero decimal strings.");
                            config.ExcludedWindowHandles.Add(new IntPtr(handle));
                        }
                    }
                    command.Configuration = config; break;
                case "automatic": command.Flag = Boolean(root, "enabled"); break;
                case "original": command.Flag = Boolean(root, "show"); break;
                case "mode": command.Mode = Choice(root, "mode", "automatic", "hotkey"); break;
                case "once": case "clear": case "close": break;
                case "theme": command.Theme = ParseTheme(root.ContainsKey("theme") ? root["theme"] : null); break;
                case "result":
                    command.Id = Integer(root, "id", 1, Int32.MaxValue);
                    if (root.ContainsKey("error")) {
                        command.Error = Text(root, "error", 4096);
                        if (root.ContainsKey("result")) throw new ArgumentException("Result and error are mutually exclusive.");
                        command.NeedsSettings = root.ContainsKey("needsSettings") && Boolean(root, "needsSettings");
                    } else {
                        if (!root.ContainsKey("result") || !(root["result"] is Dictionary<string, object>)) throw new ArgumentException("Missing result.");
                        string result = Wire.Json().Serialize(root["result"]);
                        if (Encoding.UTF8.GetByteCount(result) > Wire.MaxResultBytes) throw new ArgumentException("Result exceeds 2 MB.");
                        command.Result = TranslationProtocol.ParseLayout(result);
                    }
                    break;
                default: throw new ArgumentException("Unknown command type.");
            }
            return command;
        }

        static string Text(Dictionary<string, object> source, string key, int maximum)
        {
            object value;
            string text = source.TryGetValue(key, out value) ? value as string : null;
            if (String.IsNullOrWhiteSpace(text) || text.Length > maximum || text.IndexOfAny(new char[] { '\r', '\n', '\0' }) >= 0) throw new ArgumentException("Invalid " + key + ".");
            return text.Trim();
        }
        static bool Boolean(Dictionary<string, object> source, string key)
        {
            object value;
            if (!source.TryGetValue(key, out value) || !(value is bool)) throw new ArgumentException("Invalid " + key + ".");
            return (bool)value;
        }
        static int Integer(Dictionary<string, object> source, string key, int minimum, int maximum)
        {
            object value;
            if (!source.TryGetValue(key, out value) || !(value is int)) throw new ArgumentException("Invalid " + key + ".");
            int number = (int)value;
            if (number < minimum || number > maximum) throw new ArgumentException("Invalid " + key + ".");
            return number;
        }
        static string Choice(Dictionary<string, object> source, string key, string first, string second)
        {
            string value = Text(source, key, 64);
            if (value != first && value != second) throw new ArgumentException("Invalid " + key + ".");
            return value;
        }
        static Dictionary<string, string> ParseTheme(object value)
        {
            var root = value as Dictionary<string, object>;
            if (root == null) throw new ArgumentException("Invalid theme.");
            var theme = new Dictionary<string, string>();
            foreach (string name in new string[] { "background", "foreground", "accent", "border" }) {
                string color = Text(root, name, 7); int rgb;
                if (color.Length != 7 || color[0] != '#' || !Int32.TryParse(color.Substring(1), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out rgb)) throw new ArgumentException("Theme colors must be #RRGGBB.");
                theme[name] = color;
            }
            return theme;
        }
    }

    internal static class Wire
    {
        internal const int MaxLineBytes = 32000000, MaxResultBytes = 2000000;
        internal static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = MaxLineBytes, RecursionLimit = 32 }; }
        internal static object Layout(TranslationResult result)
        {
            var blocks = new List<object>();
            if (result != null) foreach (var block in result.Blocks) blocks.Add(new {
                box = new float[] { block.Box.Left, block.Box.Top, block.Box.Right, block.Box.Bottom }, text = block.Text,
                background = ColorTranslator.ToHtml(Color.FromArgb(block.Background.R, block.Background.G, block.Background.B)),
                foreground = ColorTranslator.ToHtml(Color.FromArgb(block.Foreground.R, block.Foreground.G, block.Foreground.B))
            });
            return new { blocks = blocks };
        }
        // Reads bytes, not unbounded TextReader.ReadLine. EOF with an incomplete record is discarded.
        internal static void ReadLines(Stream input, Action<string> line)
        {
            byte[] buffer = new byte[8192];
            var utf8 = new UTF8Encoding(false, true);
            using (var record = new MemoryStream()) {
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                    for (int i = 0; i < count; i++) {
                        if (buffer[i] == 10) {
                            string text = utf8.GetString(record.GetBuffer(), 0, (int)record.Length).TrimEnd('\r');
                            record.SetLength(0); record.Position = 0;
                            if (text.Length > 0) line(text);
                        } else {
                            if (record.Length >= MaxLineBytes) throw new InvalidDataException("Command exceeds 32 MB.");
                            record.WriteByte(buffer[i]);
                        }
                    }
                }
            }
        }
    }

    internal sealed class TranslationException : Exception
    {
        internal bool NeedsSettings;
        internal TranslationException(string message, bool needsSettings) : base(message) { NeedsSettings = needsSettings; }
    }

    // All methods, including cancellation callbacks, execute on the controller's STA.
    internal sealed class TranslationBridge : IDisposable
    {
        readonly Action<object> emit;
        readonly Dictionary<long, TaskCompletionSource<TranslationResult>> pending = new Dictionary<long, TaskCompletionSource<TranslationResult>>();
        int serial;
        bool disposed;
        internal int PendingCount { get { return pending.Count; } }
        internal TranslationBridge(Action<object> emit) { this.emit = emit; }
        internal async Task<TranslationResult> Translate(Configuration config, string image, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (disposed) throw new OperationCanceledException();
            if (serial == Int32.MaxValue) throw new TranslationException("Translation request limit reached; reopen the tool.", false);
            long id = ++serial;
            var completion = new TaskCompletionSource<TranslationResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(id, completion);
            try {
                using (token.Register(delegate {
                    if (pending.Remove(id)) { emit(new { type = "cancel", id = id }); completion.TrySetCanceled(); }
                })) {
                    emit(new { type = "request", id = id, image = image, target = config.Target, backend = config.Backend });
                    return await completion.Task;
                }
            } finally { pending.Remove(id); }
        }
        internal void Receive(Command command)
        {
            TaskCompletionSource<TranslationResult> completion;
            if (!pending.TryGetValue(command.Id, out completion)) return;
            pending.Remove(command.Id);
            if (command.Error != null) completion.TrySetException(new TranslationException(command.Error, command.NeedsSettings));
            else completion.TrySetResult(command.Result);
        }
        internal void Expire()
        {
            foreach (var entry in new List<KeyValuePair<long, TaskCompletionSource<TranslationResult>>>(pending)) {
                pending.Remove(entry.Key); emit(new { type = "cancel", id = entry.Key });
                entry.Value.TrySetException(new TranslationException("翻译响应超时，请重试。", false));
            }
        }
        public void Dispose()
        {
            disposed = true;
            foreach (var entry in new List<KeyValuePair<long, TaskCompletionSource<TranslationResult>>>(pending)) {
                pending.Remove(entry.Key); emit(new { type = "cancel", id = entry.Key }); entry.Value.TrySetCanceled();
            }
        }
    }
}
