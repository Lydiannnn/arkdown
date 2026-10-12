using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Arkdown.Update {
  static class Processes {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {public uint size,usage,id;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe;}
    [DllImport("kernel32.dll",SetLastError=true)]static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32FirstW(SafeFileHandle snapshot,ref Entry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32NextW(SafeFileHandle snapshot,ref Entry entry);
    static Dictionary<int,int> Parents() {var result=new Dictionary<int,int>();using(var snap=CreateToolhelp32Snapshot(2,0)){if(snap.IsInvalid)throw new IOException("无法检查正在运行的程序。");var e=new Entry {size=(uint)Marshal.SizeOf(typeof(Entry))};if(!Process32FirstW(snap,ref e))throw new IOException("无法检查正在运行的程序。");do {result[(int)e.id]=(int)e.parent;}while(Process32NextW(snap,ref e));}return result;}
    public static int Count(string root,string name,int excludeTree) {
      var parents=Parents();int count=0;foreach(var p in Process.GetProcessesByName(name))using(p) {
        try {
          if(p.HasExited||!String.Equals(Path.GetDirectoryName(p.MainModule.FileName),root,StringComparison.OrdinalIgnoreCase))continue;
          int id=p.Id;var seen=new HashSet<int>();bool excluded=false;
          while(seen.Add(id)&&id>0) {if(id==excludeTree){excluded=true;break;}if(!parents.TryGetValue(id,out id))break;}
          if(!excluded)count++;
        }catch { if(!p.HasExited)throw new IOException("无法确认同名程序的安装路径，请正常关闭其他 Arkdown 实例后重试。"); }
      }return count;
    }
  }
}
