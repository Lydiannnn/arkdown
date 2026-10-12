using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using Arkdown.Update;

// Only compiled into the isolated fault-test binary. The runner substitutes
// these calls in copied compiler inputs; shipping source has no fault switches.
static class DiagnosticFaults {
  public static string Mode;
  static bool terminalArmed;
  public static FileStream Writer;
  public static DirectoryInfo CreateDirectory(string path) {
    if(Mode=="directory-create"&&Path.GetFileName(path)=="resources")throw new IOException("synthetic parent directory creation",unchecked((int)0x80070005));
    return Directory.CreateDirectory(path);
  }
  public static void Flush(FileStream stream) {
    stream.Flush(true);
    if(Mode=="flush-dispose") {terminalArmed=true;throw new IOException("synthetic primary flush",unchecked((int)0x80070070));}
  }
  public static string[] GetFiles(string root,string pattern,SearchOption option) {
    if(Mode=="enumerate")throw new IOException("synthetic unknown child",unchecked((int)0x80070005));
    return Directory.GetFiles(root,pattern,option);
  }
  public static void BeforeVerify(string stage) {
    if(Mode=="reopen")Writer=new FileStream(Safety.IoPath(Path.Combine(stage,"resources/app.asar")),FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete);
  }
  public static void AfterDispose() {
    if(terminalArmed) {terminalArmed=false;throw new IOException("synthetic terminal dispose",unchecked((int)0x80070005));}
  }
}
static class DiagnosticFaultTests {
  static int checks;
  static void Check(bool value,string message) {if(!value)throw new Exception(message);checks++;}
  static string Hash(byte[] bytes) {using(var stream=new MemoryStream(bytes))return Safety.Hash(stream);}
  static void Entry(ZipArchive zip,string name,byte[] bytes) {using(var stream=zip.CreateEntry(name).Open())stream.Write(bytes,0,bytes.Length);}
  static void Package(string file) {
    byte[] image=Encoding.UTF8.GetBytes("synthetic image"),asar=Encoding.UTF8.GetBytes("synthetic asar");
    var manifest=new Manifest {schemaVersion=1,product="Arkdown",version="1.0.4",edition="Lite",files=new List<ManagedFile> {
      new ManagedFile {path="Arkdown.exe",bytes=image.Length,sha256=Hash(image)},
      new ManagedFile {path="resources/app.asar",bytes=asar.Length,sha256=Hash(asar)} }};
    using(var zip=new ZipArchive(new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None),ZipArchiveMode.Create)) {
      Entry(zip,"Arkdown.exe",image);Entry(zip,"resources/app.asar",asar);Entry(zip,Manifest.Relative,Encoding.UTF8.GetBytes(Safety.Json.Serialize(manifest)));
    }
  }
  static void Run(string mode) {
    string temp=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');
    string root=Path.Combine(temp,"arkdown-preflight-diagnostics-"+Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    string session=Path.Combine(root,".ArkdownUpdate-fixture"),stage=Path.Combine(session,"stage"),package=Path.Combine(root,"package.zip");
    try {
      Package(package);DiagnosticFaults.Mode=mode;Exception caught=null;
      try {PackageStage.Extract(package,stage,"1.0.4","Lite");}catch(Exception error){caught=error;}
      Check(caught!=null,mode+" must fail");
      var record=FailureDiagnostics.Build(caught,new HandoffRequest {session=session,target=Path.Combine(root,"target"),package=package});
      Console.WriteLine("FAULT_DIAGNOSTIC "+mode+" "+Safety.Json.Serialize(record));
      Check(record!=null&&Safety.Json.Serialize(record).Length<=8192,mode+" bounded diagnostic");
      Check(!Safety.Json.Serialize(record).Contains(root)&&!Safety.Json.Serialize(record).Contains("synthetic"),mode+" no private path or messages");
      if(mode=="reopen") {
        Check(caught is System.ComponentModel.Win32Exception,"original Native.Validate exception preserved");
        Check((string)record["phase"]=="stage.verify.open"&&(string)record["operation"]=="CreateFileW","actual verification open identified");
        Check((int)record["nativeErrorCode"]==32&&(string)record["relativePath"]=="resources/app.asar","actual native sharing code and exact file");
        Check((uint)record["access"]==0x80000000u&&(uint)record["share"]==1u&&(uint)record["creation"]==3u&&(uint)record["flags"]==0x00200000u,"original native open policy");
      } else if(mode=="flush-dispose") {
        Check(caught.HResult==unchecked((int)0x80070005),"original terminal exception remains terminal");
        Check((string)record["phase"]=="stage.extract.flush"&&(int)record["nativeErrorCode"]==112,"first Flush error survives Dispose replacement");
        Check(((string)record["primaryStack"]).Contains("DiagnosticFaults.Flush")&&((string)record["terminalStack"]).Contains("DiagnosticFaults.AfterDispose"),"primary and terminal stacks remain distinct");
      } else if(mode=="directory-create") {
        Check(caught is IOException&&caught.HResult==unchecked((int)0x80070005),"original directory creation exception preserved");
        Check((string)record["phase"]=="stage.extract.entry"&&record["operation"]==null,"directory creation retains entry context without inventing a native operation");
        Check((string)record["pathScope"]=="stage"&&(string)record["pathPrecision"]=="exact"&&(string)record["relativePath"]=="resources","directory creation identifies the failed parent directory rather than its child file");
        Check(record["access"]==null&&record["share"]==null&&record["creation"]==null&&record["flags"]==null,"directory creation does not pretend CreateFile was reached");
      } else {
        Check((string)record["phase"]=="stage.enumerate"&&(string)record["operation"]=="Directory.GetFiles","enumeration operation identified");
        Check((string)record["pathScope"]=="stage"&&(string)record["pathPrecision"]=="root-only"&&record["relativePath"]==null,"unknown enumeration child not guessed");
      }
      if(DiagnosticFaults.Writer!=null) {DiagnosticFaults.Writer.Dispose();DiagnosticFaults.Writer=null;}
      DiagnosticFaults.Mode=null;
      // A second successful call on this same thread cannot inherit the first failure.
      var success=PackageStage.Extract(package,Path.Combine(session,"success"),"1.0.4","Lite");
      Check(success.Snapshot().Count==3,"success after failure has no retained lock");
      var unrelated=FailureDiagnostics.Build(new InvalidDataException("next"),new HandoffRequest());
      Check(unrelated["nativeErrorCode"]==null,"failure snapshot consumed before next operation");
    } finally {
      if(DiagnosticFaults.Writer!=null) {DiagnosticFaults.Writer.Dispose();DiagnosticFaults.Writer=null;}
      if(Path.GetDirectoryName(Path.GetFullPath(root))!=temp||!Path.GetFileName(root).StartsWith("arkdown-preflight-diagnostics-"))throw new Exception("unsafe fixture cleanup");
      Directory.Delete(root,true);
    }
  }
  static void Main(string[] args) {
    try {Safety.EnableLongPaths();foreach(string mode in args.Length==0?new[]{"directory-create","reopen","flush-dispose","enumerate"}:args)Run(mode);Console.WriteLine("PASS "+checks+" controlled preflight fault checks");}
    catch(Exception error) {Console.WriteLine("FAIL "+error.GetType().Name+": "+error.Message);Environment.ExitCode=1;}
  }
}
