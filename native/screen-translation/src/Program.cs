using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Arkdown.ScreenTranslation
{
    internal sealed class TranslationContext : ApplicationContext
    {
        readonly Control dispatcher = new Control();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1000 };
        readonly Controller controller;
        readonly StreamWriter output;
        readonly Stream input;
        readonly Process parent;
        bool closing;

        internal TranslationContext(int parentId)
        {
            input = Console.OpenStandardInput();
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            // A native control handle for dispatch only; there is no hidden legacy control form.
            IntPtr handle = dispatcher.Handle;
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            if (parentId > 0) parent = Process.GetProcessById(parentId);
            controller = new Controller(new TranslationSurface(parentId), Emit);
            timer.Tick += delegate {
                if (parent != null && parent.HasExited) { Close(); return; }
                controller.Tick();
            };
            timer.Start();
            Emit(new { type = "ready", protocol = 1 }); controller.State();
            var reader = new Thread(ReadInput) { IsBackground = true, Name = "screen-translation-protocol" }; reader.Start();
        }
        void Emit(object value)
        {
            if (closing) return;
            try { output.WriteLine(Wire.Json().Serialize(value)); }
            catch (IOException) { Post(Close); }
            catch (ObjectDisposedException) { Post(Close); }
        }
        void ReadInput()
        {
            try {
                Wire.ReadLines(input, delegate(string line) {
                    try { var command = Command.Parse(line); Post(delegate { Apply(command); }); }
                    catch (Exception) { Post(delegate { Emit(new { type = "error", message = "Invalid screen translation command." }); }); }
                });
            } catch (Exception) {
                Post(delegate { Emit(new { type = "error", message = "Screen translation input stream failed." }); });
            } finally { Post(Close); }
        }
        void Post(Action action)
        {
            if (closing || dispatcher.IsDisposed) return;
            try { dispatcher.BeginInvoke(action); } catch (InvalidOperationException) { }
        }
        void Apply(Command command)
        {
            if (closing) return;
            if (command.Type == "close") { Close(); return; }
            try { controller.Handle(command); }
            catch (Exception exception) {
                string message = exception is ArgumentException ? exception.Message : "Screen translation command failed.";
                Emit(new { type = "error", message = message }); controller.ReportError(message);
            }
        }
        void Close()
        {
            if (closing) return;
            // Cancellation is emitted before closing the writer; async callbacks see disposed state.
            controller.Dispose(); closing = true;
            timer.Stop(); timer.Dispose();
            input.Dispose(); output.Dispose();
            if (parent != null) parent.Dispose();
            dispatcher.Dispose(); ExitThread();
        }
        protected override void Dispose(bool disposing) { if (disposing && !closing) Close(); base.Dispose(disposing); }
    }
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try {
                int parent = 0;
                if (args.Length != 0 && (args.Length != 2 || args[0] != "--parent-pid" || !Int32.TryParse(args[1], out parent) || parent <= 0)) throw new ArgumentException("Invalid parent process argument.");
                Native.EnableDpi(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                using (var context = new TranslationContext(parent)) Application.Run(context);
                return 0;
            } catch (Exception) {
                using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) output.WriteLine("{\"type\":\"error\",\"message\":\"Screen translation helper could not start.\"}");
                return 1;
            }
        }
    }
}
