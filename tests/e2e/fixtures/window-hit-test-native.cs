using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;

// Owned, synthetic windows only. No user window titles or document content are inspected.
public class HitFixtureForm : Form {
  public int AdditionalStyle;
  protected override CreateParams CreateParams {
    get { var value = base.CreateParams; value.ExStyle |= AdditionalStyle; return value; }
  }
}
public static class HitFixture {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static HitFixtureForm first, second, overlay;
  static HitFixtureForm Make(int x, int y, int width, int height, int style = 0) {
    var form = new HitFixtureForm { AdditionalStyle = style, Text = "Arkdown synthetic window test",
      StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(x, y, width, height),
      BackColor = Color.FromArgb(34, 66, 99), TopMost = true, AutoScaleMode = AutoScaleMode.None };
    form.Show();
    return form;
  }
  static object Describe(Form form) {
    ArkdownWindowHitTest.RECT bounds;
    if (ArkdownWindowHitTest.DwmGetWindowAttribute(form.Handle, 9, out bounds, 16) != 0)
      ArkdownWindowHitTest.GetWindowRect(form.Handle, out bounds);
    return new { hwnd = ArkdownWindowHitTest.HandleString(form.Handle),
      boundsPx = new { x = bounds.Left, y = bounds.Top, width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top } };
  }
  static void Reply() { Console.WriteLine(Json.Serialize(new { first = Describe(first), second = Describe(second), overlay = overlay == null ? null : Describe(overlay) })); }
  static void Execute(string command) {
    if (command == "close") { if (overlay != null) overlay.Close(); second.Close(); first.Close(); return; }
    if (overlay != null) { overlay.Close(); overlay = null; }
    if (command == "move") first.Left += 40;
    else if (command == "minimize") first.WindowState = FormWindowState.Minimized;
    else if (command == "restore") { first.WindowState = FormWindowState.Normal; first.BringToFront(); }
    else if (command == "maximize") first.WindowState = FormWindowState.Maximized;
    else if (command == "overlay" || command == "transparent" || command == "layered" || command == "tool" || command == "noactivate" || command == "passthrough") {
      int style = command == "tool" ? 0x80 : command == "noactivate" ? 0x08000000 : command == "passthrough" ? 0x20 : 0;
      overlay = Make(first.Left, first.Top, first.Width, first.Height, style);
      if (command == "transparent") overlay.Opacity = 0;
      if (command == "layered") overlay.Opacity = .65;
      overlay.BringToFront();
    }
    Reply();
  }
  [STAThread] public static void Main() {
    ArkdownWindowHitTest.SetProcessDpiAwarenessContext(new IntPtr(-4));
    Application.EnableVisualStyles();
    first = Make(100, 120, 620, 420);
    second = Make(800, 120, 480, 380);
    var reader = new Thread(() => {
      string line;
      while ((line = Console.ReadLine()) != null) {
        var command = line;
        if (first.IsDisposed) return;
        first.BeginInvoke(new Action(() => Execute(command)));
        if (command == "close") return;
      }
      if (!first.IsDisposed) first.BeginInvoke(new Action(() => Execute("close")));
    });
    reader.IsBackground = true; reader.Start();
    // Make() already showed the form; emit readiness once its message loop starts.
    first.BeginInvoke(new Action(Reply));
    Application.Run(first);
  }
}
