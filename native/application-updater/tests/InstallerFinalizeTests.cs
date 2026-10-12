using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Arkdown.Update;

// All file contents below are synthetic. Never restore the flagged legacy HTML.
class InstallerFinalizeTests {
  static int passed,skipped;
  static readonly string Synthetic="independent harmless migration test content";
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool CreateHardLink(string name,string existing,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.I1)]
  static extern bool CreateSymbolicLink(string name,string target,uint flags);
  static void Check(bool result,string name) {if(!result)throw new Exception(name);passed++;Console.WriteLine("PASS "+name);}
  static void Reject(Action action,string name) {bool rejected=false;try {action();}catch {rejected=true;}Check(rejected,name);}
  static string Hash(string value) {using(var s=new MemoryStream(Encoding.UTF8.GetBytes(value)))return Safety.Hash(s);}
  static string Manual(string root) {return Path.Combine(root,InstallerFinalize.ManualRelative.Replace('/',Path.DirectorySeparatorChar));}
  static string Guard(string root) {return Path.Combine(root,InstallerFinalize.GuardName);}
  static string Case(string root,string name) {string target=Path.Combine(root,name);Directory.CreateDirectory(target);return target;}
  static void PutManual(string root,string text) {Directory.CreateDirectory(Path.GetDirectoryName(Manual(root)));File.WriteAllText(Manual(root),text,new UTF8Encoding(false));}
  static int Phase(string phase,string root,string manifest,string guard) {
    return InstallerFinalize.Run(new[]{"--installer-finalize",phase,root,manifest,"1.0.4","Lite",guard});
  }
  static string Payload(string root,string edition) {
    Directory.CreateDirectory(Path.Combine(root,"resources"));
    var manifest=new Manifest {schemaVersion=1,product="Arkdown",version="1.0.4",edition=edition,files=new List<ManagedFile>()};
    foreach(string relative in new[]{"Arkdown.exe","resources/app.asar","resources/package-edition.json"}) {
      string target=Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar));
      // These text placeholders are only hashed, never launched.
      File.WriteAllText(target,"synthetic "+relative,new UTF8Encoding(false));
      manifest.files.Add(new ManagedFile {path=relative,bytes=new FileInfo(target).Length,sha256=Safety.HashFile(target)});
    }
    Safety.WriteJson(Path.Combine(root,Manifest.Relative),manifest);
    return Safety.HashFile(Path.Combine(root,Manifest.Relative));
  }
  static void DeleteCases(string root) {
    Check(InstallerFinalize.KnownManual(426772,"b882985d7262ed342636acb8c33e6793c9f21fd92caf2eae9b50d590178a121b"),"fixed legacy metadata policy");
    Check(!InstallerFinalize.KnownManual(426773,InstallerFinalize.ManualSha256)&&!InstallerFinalize.KnownManual(426772,new string('a',64)),"unknown legacy metadata refused");
    string target=Case(root,"exact");PutManual(target,Synthetic);File.WriteAllText(Path.Combine(target,"personal.md"),"keep");
    InstallerFinalize.DeleteVerifiedManual(target,Encoding.UTF8.GetByteCount(Synthetic),Hash(Synthetic));
    Check(!File.Exists(Manual(target))&&File.ReadAllText(Path.Combine(target,"personal.md"))=="keep","held-handle deletion removes only fixed synthetic manual");
    InstallerFinalize.DeleteVerifiedManual(target,Encoding.UTF8.GetByteCount(Synthetic),Hash(Synthetic));
    Check(!File.Exists(Manual(target)),"missing manual is idempotent");
    target=Case(root,"missing-parent");InstallerFinalize.DeleteVerifiedManual(target,1,Hash("x"));Check(Directory.GetFiles(target).Length==0,"missing parent stays absent");
    target=Case(root,"unknown");PutManual(target,Synthetic);
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(new string('x',Synthetic.Length))),"same-size unknown content refused");
    Check(File.ReadAllText(Manual(target))==Synthetic,"unknown content retained");
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length+1,Hash(Synthetic)),"size mismatch refused");
    target=Case(root,"directory");Directory.CreateDirectory(Manual(target));File.WriteAllText(Path.Combine(Manual(target),"keep.txt"),"keep");
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,0,Hash("")),"directory at manual path refused");
    Check(File.Exists(Path.Combine(Manual(target),"keep.txt")),"directory contents retained");
    target=Case(root,"readonly");PutManual(target,Synthetic);File.SetAttributes(Manual(target),FileAttributes.ReadOnly);
    try {
      Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"read-only manual refused");
      Check((File.GetAttributes(Manual(target))&FileAttributes.ReadOnly)!=0,"read-only attributes preserved");
    } finally {File.SetAttributes(Manual(target),FileAttributes.Normal);}
    target=Case(root,"locked");PutManual(target,Synthetic);
    using(var locked=new FileStream(Manual(target),FileMode.Open,FileAccess.Read,FileShare.Read))
      Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"occupied manual refused");
    Check(File.ReadAllText(Manual(target))==Synthetic,"occupied manual retained");
    target=Case(root,"hardlink");PutManual(target,Synthetic);string alias=Path.Combine(target,"personal.html");
    if(!CreateHardLink(alias,Manual(target),IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"hard-linked manual refused");
    Check(File.ReadAllText(alias)==Synthetic&&File.Exists(Manual(target)),"both hard-link names retained");
    target=Case(root,"pins");PutManual(target,Synthetic);string parent=Path.GetDirectoryName(Manual(target));
    using(var pins=new DirectoryPins())using(var held=new LockedFile(Manual(target),true,false)) {
      pins.Pin(parent,false);
      Reject(()=>Directory.Move(parent,parent+"-moved"),"held ancestor prevents replacement");
      Reject(()=>File.WriteAllText(Manual(target),"changed"),"held manual prevents writes");
      held.Revalidate(Manual(target));
    }
    target=Path.Combine(root,"ancestor-junction");
    Check((File.GetAttributes(Path.GetDirectoryName(Manual(target)))&FileAttributes.ReparsePoint)!=0,"junction fixture established");
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"directory junction ancestor refused");
    Check(File.ReadAllText(Path.Combine(root,"junction-target","MANUAL.html"))==Synthetic,"junction target retained");
    LinkCases(root);
  }
  static void LinkCases(string root) {
    string outside=Case(root,"link-target"),target=Case(root,"symlink");
    File.WriteAllText(Path.Combine(outside,"original.html"),Synthetic);Directory.CreateDirectory(Path.GetDirectoryName(Manual(target)));
    if(!CreateSymbolicLink(Manual(target),Path.Combine(outside,"original.html"),2)) {
      int error=Marshal.GetLastWin32Error();if(error!=1314&&error!=87)throw new Win32Exception(error);
      skipped++;Console.WriteLine("SKIP symbolic-link fixtures unavailable (Win32 "+error+")");return;
    }
    Check((File.GetAttributes(Manual(target))&FileAttributes.ReparsePoint)!=0,"file symlink fixture established");
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"file symlink refused");
    Check(File.ReadAllText(Path.Combine(outside,"original.html"))==Synthetic,"symlink target retained");
    target=Case(root,"ancestor-link");Directory.CreateDirectory(Path.Combine(target,"resources","components"));
    File.WriteAllText(Path.Combine(outside,"MANUAL.html"),Synthetic);
    if(!CreateSymbolicLink(Path.GetDirectoryName(Manual(target)),outside,3))throw new Win32Exception(Marshal.GetLastWin32Error());
    Check((File.GetAttributes(Path.GetDirectoryName(Manual(target)))&FileAttributes.ReparsePoint)!=0,"ancestor symlink fixture established");
    Reject(()=>InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic)),"directory reparse ancestor refused");
    Check(File.ReadAllText(Path.Combine(outside,"MANUAL.html"))==Synthetic,"ancestor link target retained");
  }
  static void GuardCases(string root) {
    string target=Case(root,"workflow"),manifest=Payload(target,"Lite");
    Check(Phase("prepare",target,manifest,"-")==0,"prepare publishes complete guard");
    string guard=Safety.HashFile(Guard(target));
    Check(Phase("prepare",target,manifest,"-")==2&&Safety.HashFile(Guard(target))==guard,"retry signals existing guard and preserves identity");
    Check(Directory.GetFiles(target,InstallerFinalize.GuardName+".*.tmp").Length==0,"guard publication leaves no temp object");
    Check(Phase("migrate",target,manifest,new string('f',64))==24&&File.Exists(Guard(target)),"changed guard identity refuses migration");
    Check(Phase("migrate",target,new string('f',64),guard)==20&&File.Exists(Guard(target)),"unexpected installed manifest refuses migration");
    File.WriteAllText(Path.Combine(target,"resources","app.asar"),"tampered");
    Check(Phase("migrate",target,manifest,guard)==20&&File.Exists(Guard(target)),"partial installed payload retains guard");
    manifest=Payload(target,"Lite");
    Check(Phase("migrate",target,manifest,guard)==0&&File.Exists(Guard(target)),"migration success alone retains guard");
    PutManual(target,Synthetic);
    Check(Phase("migrate",target,manifest,guard)==21&&File.ReadAllText(Manual(target))==Synthetic,"public CLI never accepts synthetic legacy identity");
    Check(Phase("complete",target,manifest,guard)==21&&File.Exists(Guard(target)),"remaining legacy object blocks completion");
    InstallerFinalize.DeleteVerifiedManual(target,Synthetic.Length,Hash(Synthetic));
    Check(Phase("complete",target,manifest,guard)==0&&!File.Exists(Guard(target)),"complete removes verified guard after absence");
    Check(Phase("prepare",target,manifest,"-")==0,"new installer retry can establish a fresh guard");
    string next=Safety.HashFile(Guard(target));Check(next!=guard,"new prepare gets new instance identity");
    Check(Phase("migrate",target,manifest,next)==0&&Phase("complete",target,manifest,next)==0,"fresh retry completes");
    target=Case(root,"unknown-guard");File.WriteAllText(Guard(target),"user file");
    Check(Phase("prepare",target,new string('a',64),"-")==24&&File.ReadAllText(Guard(target))=="user file","unknown guard never overwritten");
    target=Case(root,"guard-directory");Directory.CreateDirectory(Guard(target));
    Check(Phase("prepare",target,new string('a',64),"-")!=0&&Directory.Exists(Guard(target)),"guard directory retained");
    target=Case(root,"guard-hardlink");manifest=Payload(target,"Lite");Check(Phase("prepare",target,manifest,"-")==0,"hardlink fixture starts with guard");
    string alias=Path.Combine(target,"keep.ini");if(!CreateHardLink(alias,Guard(target),IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
    Check(Phase("prepare",target,manifest,"-")==22&&File.Exists(alias),"hard-linked guard refused");
    target=Case(root,"in-app-guard");manifest=Payload(target,"Lite");
    string original="[ArkdownUpdate]\r\nSchema=1\r\nTarget="+target+"\r\nSession="+Path.Combine(root,".ArkdownUpdate-"+new string('a',32))+"\r\n";
    File.WriteAllText(Guard(target),original,Encoding.Unicode);guard=Safety.HashFile(Guard(target));
    Check(Phase("prepare",target,manifest,"-")==2&&Safety.HashFile(Guard(target))==guard,"recognized app-update guard signals existing identity");
    Check(Phase("migrate",target,manifest,guard)==0&&File.Exists(Guard(target)),"app-update guard retained through migration");
    target=Case(root,"full-pin");manifest=Payload(target,"Full");Check(Phase("prepare",target,manifest,"-")==0,"full fixture prepared");
    guard=Safety.HashFile(Guard(target));PutManual(target,Synthetic);
    Check(InstallerFinalize.Run(new[]{"--installer-finalize","migrate",target,manifest,"1.0.4","Full",guard})==20&&File.Exists(Manual(target)),"Full requires pinned r2 component inventory before cleanup");
    Check(InstallerFinalize.Run(new[]{"--installer-finalize","arbitrary-delete",target,manifest,"1.0.4","Full",guard})==10,"unknown CLI mode refused");
  }
  static void Main(string[] args) {
    Console.OutputEncoding=new UTF8Encoding(false);
    try {
      Safety.EnableLongPaths();if(args.Length!=1)throw new Exception("Pass isolated fixture root");
      string root=Safety.Full(args[0]);if(!Directory.Exists(root))throw new Exception("Fixture root must already exist");
      DeleteCases(root);GuardCases(root);
      Console.WriteLine("PASS installer finalization: "+passed+" assertions; "+skipped+" skipped groups");
    } catch(Exception error) {Console.WriteLine(error);Environment.ExitCode=1;}
    // The serial Node runner owns cleanup after the entire process tree exits.
  }
}
