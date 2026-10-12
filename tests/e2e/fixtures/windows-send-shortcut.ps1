$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ArkdownShortcutSender {
  [StructLayout(LayoutKind.Sequential)]
  private struct MouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct KeyboardInput {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct HardwareInput {
    public uint message;
    public ushort parameterLow;
    public ushort parameterHigh;
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct InputUnion {
    [FieldOffset(0)] public MouseInput mouse;
    [FieldOffset(0)] public KeyboardInput keyboard;
    [FieldOffset(0)] public HardwareInput hardware;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Input {
    public uint type;
    public InputUnion data;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, Input[] inputs, int size);

  private static Input Keyboard(ushort virtualKey, uint flags) {
    return new Input {
      type = 1,
      data = new InputUnion {
        keyboard = new KeyboardInput {
          virtualKey = virtualKey,
          flags = flags,
        },
      },
    };
  }

  public static bool SendScreenshotShortcut() {
    const uint KeyUp = 0x0002;
    const ushort Shift = 0x10;
    const ushort Control = 0x11;
    const ushort Q = 0x51;
    Input[] inputs = {
      Keyboard(Shift, 0),
      Keyboard(Control, 0),
      Keyboard(Q, 0),
      Keyboard(Q, KeyUp),
      Keyboard(Control, KeyUp),
      Keyboard(Shift, KeyUp),
    };
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
  }
}
'@

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ok = [ArkdownShortcutSender]::SendScreenshotShortcut()
'{"ok":' + $ok.ToString().ToLowerInvariant() + '}'
