# Enumerate the SESSION font table for the island's CJK families.
# After the app loads them with AddFontResourceEx(0) they are session-global,
# so any process can see them. Empty result = app did not load them.
$ErrorActionPreference = 'Stop'

$src = @"
using System;
using System.Runtime.InteropServices;

public class SessionFontEnum {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct LOGFONT {
    public int h; public int w; public int esc; public int ori; public int weight;
    public byte i; public byte u; public byte s; public byte cs; public byte op;
    public byte cp; public byte q; public byte pf;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string face;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct ELFX {
    public LOGFONT lf;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string full;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string style;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string script;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct NTMX {
    public int a,b,c,d,e,f,g,h2,i2,j,k;
    public byte p1,p2,p3,p4,p5,p6,p7,p8,p9;
    public int flags; public uint em,ch,avg;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct NTMEX { public NTMX tm; public uint s1,s2,s3,s4; }

  public delegate int P(ref ELFX e, ref NTMEX n, uint t, IntPtr l);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
  public static extern int EnumFontFamiliesExW(IntPtr dc, ref LOGFONT lf, P p, IntPtr lp, uint fl);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);

  public static string Found = "";

  public static int Cb(ref ELFX e, ref NTMEX n, uint t, IntPtr l) {
    Found += "'" + e.lf.face + "' w" + e.lf.weight + "  ";
    return 1;
  }

  public static string Enum(string face) {
    Found = "";
    LOGFONT lf = new LOGFONT();
    lf.cs = 1; lf.face = face;
    IntPtr dc = GetDC(IntPtr.Zero);
    EnumFontFamiliesExW(dc, ref lf, Cb, IntPtr.Zero, 0);
    ReleaseDC(IntPtr.Zero, dc);
    return Found.Length > 0 ? Found : "NONE";
  }
}
"@
Add-Type -TypeDefinition $src

Write-Host ("base   : " + [SessionFontEnum]::Enum('Noto Sans CJK SC'))
Write-Host ("medium : " + [SessionFontEnum]::Enum('Noto Sans CJK SC Medium'))
