using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Arkdown.Update {
  static class Safety {
    // csc.exe defaults to the old Framework compatibility mode. Set these before
    // any path operation (including recovery startup); no machine policy changes.
    public static void EnableLongPaths() {
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
    }
    public const long MaxBytes=64L*1024*1024*1024;
    public static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=32*1024*1024, RecursionLimit=12 };
    public static string Relative(string value) {
      if(String.IsNullOrEmpty(value)||value.Length>2000||value.StartsWith("/")||value.Contains("\\"))throw new InvalidDataException("Unsafe relative path");
      foreach(string part in value.Split('/')) if(part=="."||part==".."||part.Length==0||part.EndsWith(".")||part.EndsWith(" ")||Regex.IsMatch(part,"[<>:\"|?*\\x00-\\x1f]")||Regex.IsMatch(part,@"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe relative path");
      string first=value.Split('/')[0];
      if(new[]{"portable-data","userdata","user-data","temp",".git",".arkdown-installation.ini",".arkdown-update-pending.json",".arkdown-installer-update.ini"}.Contains(first,StringComparer.OrdinalIgnoreCase)||first.StartsWith("unins",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("User data is not managed");
      return value;
    }
    public static string Under(string root,string relative) { return Path.Combine(root,Relative(relative).Replace('/',Path.DirectorySeparatorChar)); }
    // Use extended local paths only at I/O boundaries, after normalization. Keep
    // journals, containment comparisons and handle identity checks canonical.
    public static string IoPath(string path) {
      string full=Path.GetFullPath(path);
      if(!Path.IsPathRooted(path)||full.StartsWith(@"\\")||full.Length<3||full[1]!=':'||full.IndexOf(':',2)>=0)throw new InvalidDataException("Local absolute path required");
      return @"\\?\"+full;
    }
    public static bool FileExists(string path) { return File.Exists(IoPath(path)); }
    public static bool DirectoryExists(string path) { return Directory.Exists(IoPath(path)); }
    public static string Full(string path) {
      string full=Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
      if(!Path.IsPathRooted(path)||full.Length<4||full.StartsWith(@"\\")||full.IndexOf(':',2)>=0)throw new InvalidDataException("Local absolute directory required");
      return full;
    }
    public static string Hash(Stream stream) { stream.Position=0; using(var sha=SHA256.Create()) { string hash=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();stream.Position=0;return hash; } }
    public static string HashFile(string file) { using(var f=new LockedFile(file,false,false))return Hash(f.Stream); }
    public static T ReadJson<T>(string file,int max) { using(var f=new LockedFile(file,false,false)) { if(f.Stream.Length>max)throw new InvalidDataException("Metadata too large");using(var r=new StreamReader(f.Stream,Encoding.UTF8,true,4096,true))return Json.Deserialize<T>(r.ReadToEnd()); } }
    public static void WriteJson(string file,object value) {
      byte[] bytes=new UTF8Encoding(false,true).GetBytes(Json.Serialize(value)); string temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
      using(var f=new FileStream(IoPath(temp),FileMode.CreateNew,FileAccess.Write,FileShare.None)) { f.Write(bytes,0,bytes.Length);f.Flush(true); }
      if(FileExists(file))File.Replace(IoPath(temp),IoPath(file),null);else File.Move(IoPath(temp),IoPath(file));
    }
    public static void Version(string value) { if(value==null||!Regex.IsMatch(value,@"^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$"))throw new InvalidDataException("Invalid version"); }
    public static void Verify(LockedFile file,ManagedFile item) { if(file.Stream.Length!=item.bytes||Hash(file.Stream)!=item.sha256)throw new InvalidDataException("Program file changed: "+item.path); }
  }
  // Pin every ancestor without FILE_SHARE_DELETE. A junction or directory cannot be
  // exchanged while a child pathname is in use. File mutations use the held file
  // handle, with no replace-existing flag, rather than deleting a pathname.
  sealed class DirectoryPins : IDisposable {
    readonly Dictionary<string,SafeFileHandle> pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    public void Pin(string input,bool create) {
      string path=Path.GetFullPath(input).TrimEnd('\\');if(path.Length==2)path+="\\";
      if(pins.ContainsKey(path))return;
      // Archives need not contain explicit directory entries. Establish and pin
      // each missing parent before creating its child; never skip ancestor checks.
      string parent=Path.GetDirectoryName(path);if(!String.IsNullOrEmpty(parent)&&parent!=path)Pin(parent,create);
      if(create&&!Safety.DirectoryExists(path)) {
        try {Directory.CreateDirectory(Safety.IoPath(path));}
        catch(Exception error) {FailureDiagnostics.TryAnnotate(error,null,null,path);throw;}
      }
      SafeFileHandle h=Native.CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
      try { Native.Validate(h,path,true);pins.Add(path,h); } catch(Exception error) {
        FailureDiagnostics.TryOpen(error,path,0x80,3,3,0x02200000);
        try { h.Dispose(); }catch(Exception terminal) {FailureDiagnostics.Transfer(error,terminal);throw;}
        throw;
      }
    }
    public void Dispose() { foreach(var handle in pins.Values.Reverse())handle.Dispose();pins.Clear(); }
  }
  sealed class LockedFile : IDisposable {
    public readonly FileStream Stream; readonly SafeFileHandle handle;
    public LockedFile(string path,bool mutate,bool create) {
      handle=Native.CreateFile(path,0x80000000u|(mutate?0x00010000u:0)|(create?0x40000000u:0),1,IntPtr.Zero,create?1u:3u,0x00200000,IntPtr.Zero);
      try { Native.Validate(handle,path,false);Stream=new FileStream(handle,create?FileAccess.ReadWrite:FileAccess.Read); } catch(Exception error) {
        FailureDiagnostics.TryOpen(error,path,0x80000000u|(mutate?0x00010000u:0)|(create?0x40000000u:0),1,create?1u:3u,0x00200000);
        try { handle.Dispose(); }catch(Exception terminal) {FailureDiagnostics.Transfer(error,terminal);throw;}
        throw;
      }
    }
    public void Rename(string destination) { Native.Rename(handle,destination); }
    public void Revalidate(string path) { Native.Validate(handle,path,false); }
    public void Delete() { Native.Delete(handle); }
    public void Dispose() { Stream.Dispose();handle.Dispose(); }
  }
  static class Native {
    [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW",ExactSpelling=true)] static extern SafeFileHandle CreateFileNative(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    public static SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template) {
      return CreateFileNative(Safety.IoPath(name),access,share,security,creation,flags,template);
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint size,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr data,uint size);
    public static void Validate(SafeFileHandle handle,string expected,bool directory) {
      if(handle.IsInvalid) {int code=Marshal.GetLastWin32Error();var error=new Win32Exception(code);FailureDiagnostics.TryNative(error,"CreateFileW",code,null);throw error;}Info info;
      if(!GetFileInformationByHandle(handle,out info)) {int code=Marshal.GetLastWin32Error();var error=new Win32Exception(code);FailureDiagnostics.TryNative(error,"GetFileInformationByHandle",code,null);throw error;}
      if((info.Attr&0x400)!=0||((info.Attr&0x10)!=0)!=directory||(!directory&&info.Links!=1)) {
        var error=new InvalidDataException("Reparse or hard-link entry refused");FailureDiagnostics.TryNative(error,"GetFileInformationByHandle",null,(info.Attr&0x400)!=0?"reparse-point":(((info.Attr&0x10)!=0)!=directory?"entry-kind":"hard-link"));throw error;
      }
      var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(handle,b,(uint)b.Capacity,0);
      if(n==0) {int code=Marshal.GetLastWin32Error();var error=new InvalidDataException("Path identity changed");FailureDiagnostics.TryNative(error,"GetFinalPathNameByHandleW",code,null);throw error;}
      if(n>=b.Capacity||!String.Equals(b.ToString().Replace(@"\\?\","").TrimEnd('\\'),Path.GetFullPath(expected).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) {
        var error=new InvalidDataException("Path identity changed");FailureDiagnostics.TryNative(error,"GetFinalPathNameByHandleW",null,n>=b.Capacity?"path-too-long":"path-identity");throw error;
      }
    }
    public static void Rename(SafeFileHandle handle,string destination) {
      // FileNameLength excludes the terminator, but the Win32 conversion layer
      // still needs a NUL-terminated FileName buffer (also used by our C++ helper).
      byte[] name=Encoding.Unicode.GetBytes(Safety.IoPath(destination));int root=IntPtr.Size==8?8:4,len=root+IntPtr.Size,start=len+4,size=start+name.Length+2;
      IntPtr data=Marshal.AllocHGlobal(size);try { for(int i=0;i<size;i++)Marshal.WriteByte(data,i,0);Marshal.WriteInt32(data,len,name.Length);Marshal.Copy(name,0,IntPtr.Add(data,start),name.Length);
        if(!SetFileInformationByHandle(handle,3,data,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(data); }
    }
    public static void Delete(SafeFileHandle handle) {
      IntPtr data=Marshal.AllocHGlobal(1);
      try { Marshal.WriteByte(data,1);if(!SetFileInformationByHandle(handle,4,data,1))throw new Win32Exception(Marshal.GetLastWin32Error()); }
      finally { Marshal.FreeHGlobal(data); }
    }
  }
}
