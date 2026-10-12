using System;

class WindowHitPolicyTests
{
    static int passed;
    static void Check(bool condition, string label) { if (!condition) throw new Exception(label); passed++; Console.WriteLine("PASS " + label); }
    static bool Allowed(long style = 0, bool alphaKnown = false, byte alpha = 255, uint alphaFlags = 0,
        bool exists = true, bool visible = true, bool iconic = false, bool cloakKnown = true, int cloak = 0, bool shell = false, bool styleKnown = true)
    {
        return ArkdownWindowHitTest.CandidateAllowed(exists, visible, iconic, cloakKnown, cloak, shell, styleKnown, style, alphaKnown, alpha, alphaFlags);
    }
    static int Main()
    {
        Check(Allowed(), "ordinary candidate");
        Check(!Allowed(exists: false), "destroyed rejected");
        Check(!Allowed(visible: false), "invisible rejected");
        Check(!Allowed(iconic: true), "minimized rejected");
        Check(!Allowed(cloakKnown: false), "unknown DWM state rejected");
        Check(!Allowed(cloak: 1), "cloaked rejected");
        Check(!Allowed(shell: true), "shell candidate rejected");
        Check(!Allowed(styleKnown: false), "unknown style rejected");
        Check(!Allowed(0x80), "tool window rejected");
        Check(!Allowed(0x08000000), "noactivate rejected");
        Check(!Allowed(0x20), "explicit transparent style rejected");
        Check(Allowed(0x80000), "ordinary layered window preserved");
        Check(Allowed(0x80000, true, 180, 2), "partly translucent application preserved");
        Check(!Allowed(0x80000, true, 0, 2), "fully transparent alpha rejected");
        Check(Allowed(0x80000, true, 0, 1), "color key does not imply whole-window transparency");
        var rect = new ArkdownWindowHitTest.RECT { Left = -1200, Top = -80, Right = -600, Bottom = 320 };
        Check(ArkdownWindowHitTest.BoundsContain(rect, -1200, -80), "negative DWM origin included");
        Check(!ArkdownWindowHitTest.BoundsContain(rect, -600, 40), "exclusive right border rejected");
        Check(!ArkdownWindowHitTest.BoundsContain(rect, -1201, -80), "invisible resize margin rejected");
        Check(ArkdownWindowHitTest.BoundsContain(new ArkdownWindowHitTest.RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1080 }, 500, 400), "normal fullscreen candidate preserved");
        Check(!ArkdownWindowHitTest.BoundsContain(new ArkdownWindowHitTest.RECT(), 0, 0), "empty bounds rejected");
        Console.WriteLine("ALL " + passed + " PURE POLICY CHECKS PASSED; no Win32 calls executed");
        return 0;
    }
}
