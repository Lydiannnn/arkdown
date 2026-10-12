using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO.Pipes;
using Arkdown.Update;
class CoreTests {
  static int count;
  static readonly string DeepFile="resources/components/runtime/"+new String('d',70)+"/"+new String('e',70)+"/"+new String('f',70)+"/fixture.txt";
  static string DeepZip(string root,string version,string text) {
    string archive=Path.Combine(root,"payload-"+Guid.NewGuid().ToString("N")+".zip");
    var manifest=new Manifest {schemaVersion=1,product="Arkdown",version=version,edition="Lite",files=new List<ManagedFile>()};
    using(var zip=ZipFile.Open(archive,ZipArchiveMode.Create)) {
      foreach(string name in new[]{"Arkdown.exe","resources/app.asar",DeepFile}) {
        byte[] bytes=System.Text.Encoding.UTF8.GetBytes(text);
        using(var output=zip.CreateEntry(name).Open())output.Write(bytes,0,bytes.Length);
        using(var input=new MemoryStream(bytes))manifest.files.Add(new ManagedFile {path=name,bytes=bytes.Length,sha256=Safety.Hash(input)});
      }
      using(var writer=new StreamWriter(zip.CreateEntry(Manifest.Relative).Open(),new System.Text.UTF8Encoding(false)))writer.Write(Safety.Json.Serialize(manifest));
    }return archive;
  }
  static void LongPaths(string root) {
    string target=Path.Combine(root,"deep-target"),stage=Path.Combine(root,"deep-stage"),session=Path.Combine(root,"deep-session");
    string old=DeepZip(root,"1.0.4","old-deep"),next=DeepZip(root,"1.0.5","new-deep");
    Check(Path.Combine(target,DeepFile.Replace('/',Path.DirectorySeparatorChar)).Length>300,"fixture exceeds legacy path limit");
    PackageStage.Extract(old,target,"1.0.4","Lite");
    PackageStage.Extract(next,stage,"1.0.5","Lite");
    Check(File.ReadAllText(@"\\?\"+Path.Combine(stage,DeepFile.Replace('/',Path.DirectorySeparatorChar)))=="new-deep","extract and verify deep managed file");
    File.WriteAllText(Path.Combine(target,"personal.md"),"keep-deep");
    new PortableTransaction(target,stage,session,"1.0.4","1.0.5","Lite",FixtureInventory(stage)).Apply(null);
    Check(File.ReadAllText(@"\\?\"+Path.Combine(target,DeepFile.Replace('/',Path.DirectorySeparatorChar)))=="new-deep","commit deep managed file");
    PortableTransaction.Recover(target,session);
    Check(File.ReadAllText(@"\\?\"+Path.Combine(target,DeepFile.Replace('/',Path.DirectorySeparatorChar)))=="old-deep","recover deep managed file from journal");
    Check(File.ReadAllText(Path.Combine(target,"personal.md"))=="keep-deep","deep recovery preserves unknown data");
    string retry=Path.Combine(root,"deep-retry"),failedSession=Path.Combine(root,"deep-failed");
    PackageStage.Extract(next,retry,"1.0.5","Lite");bool injected=false;
    try {new PortableTransaction(target,retry,failedSession,"1.0.4","1.0.5","Lite",FixtureInventory(retry)).Apply(n=>{if(n==2){injected=true;throw new IOException("deep-injected");}});}catch(IOException e){if(e.Message!="deep-injected")throw;}
    Check(injected&&File.ReadAllText(@"\\?\"+Path.Combine(target,DeepFile.Replace('/',Path.DirectorySeparatorChar)))=="old-deep","rollback after deep managed file replacement");
    Check(!File.Exists(Path.Combine(target,PortableTransaction.PendingName)),"deep rollback clears pending marker");
  }
  static void Check(bool value, string name) { if (!value) throw new Exception(name); count++; }
  static void RestartAckDuringWrite(string root) {
    string target=Path.Combine(root,"restart-target"),session=Path.Combine(root,"restart-session");
    Directory.CreateDirectory(target);Directory.CreateDirectory(session);
    string exe=Path.Combine(target,"Arkdown.exe");File.Copy(Process.GetCurrentProcess().MainModule.FileName,exe);
    using(var child=Process.Start(new ProcessStartInfo {FileName=exe,Arguments="--parent",UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true})) {
      try {
        Check(child.StandardOutput.ReadLine()=="ready","restart child running");
        var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static;
        var requestField=typeof(Program).GetField("request",flags);
        var previous=requestField.GetValue(null);
        try {
          requestField.SetValue(null,new HandoffRequest {target=target,session=session,version="1.0.5",token=new string('b',64)});
          string file=Path.Combine(session,"arkdown-ready.json");
          Exception failure=null;var started=new System.Threading.ManualResetEvent(false);
          using(var writer=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)) {
            byte[] bytes=System.Text.Encoding.UTF8.GetBytes(Safety.Json.Serialize(new RestartAck {protocolVersion=1,token=new string('b',64),version="1.0.5",pid=child.Id,mode="arkdown"}));
            writer.Write(bytes,0,bytes.Length);writer.Flush(true);
            var reader=new System.Threading.Thread(()=> {started.Set();try {typeof(Program).GetMethod("WaitAck",flags).Invoke(null,new object[]{"arkdown"});}catch(Exception e){failure=e.InnerException??e;}});
            reader.IsBackground=true;reader.Start();started.WaitOne();
            // Match Node's open/write/fsync/close sequence: the final path exists
            // while its writer still holds the handle. A safe reader must wait.
            System.Threading.Thread.Sleep(350);
            writer.Dispose();
            Check(reader.Join(5000),"restart confirmation returns after writer closes");
          }
          Check(failure==null,"restart confirmation must tolerate in-flight writer: "+failure);
          Safety.WriteJson(file,new RestartAck {protocolVersion=1,token=new string('c',64),version="1.0.5",pid=child.Id,mode="arkdown"});
          Reject(()=>typeof(Program).GetMethod("WaitAck",flags).Invoke(null,new object[]{"arkdown"}),"restart still rejects mismatched token");
        } finally {requestField.SetValue(null,previous);}
      } finally {child.StandardInput.WriteLine();child.StandardInput.Close();if(!child.WaitForExit(5000)){child.Kill();child.WaitForExit();}}
    }
  }
  static void Reject(Action action, string name) { bool rejected=false; try { action(); } catch { rejected=true; } Check(rejected, name); }
  static void Package(string dir, string version, string text) {
    Directory.CreateDirectory(Path.Combine(dir,"resources"));
    File.WriteAllText(Path.Combine(dir,"Arkdown.exe"),text);
    File.WriteAllText(Path.Combine(dir,"resources","app.asar"),text);
    var files=new List<ManagedFile>();
    foreach(var name in new[]{"Arkdown.exe","resources/app.asar"}) {
      string f=Path.Combine(dir,name.Replace('/',Path.DirectorySeparatorChar));
      files.Add(new ManagedFile { path=name, bytes=new FileInfo(f).Length, sha256=Safety.HashFile(f) });
    }
    Safety.WriteJson(Path.Combine(dir,Manifest.Relative), new Manifest { schemaVersion=1, product="Arkdown",version=version,edition="Lite",files=files });
  }
  static VerifiedPackage FixtureInventory(string stage) { return new VerifiedPackage(Manifest.Read(stage,"1.0.5","Lite").WithSelf(stage)); }
  static void Main(string[] args) { try { Safety.EnableLongPaths();Run(args); } catch(Exception e) { Console.WriteLine(e.GetType().FullName+": "+e.Message+"\n"+e.StackTrace);Environment.ExitCode=1; } }
  static void Run(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    if(args.Length==1&&args[0]=="--parent") {Console.WriteLine("ready");Console.ReadLine();return;}
    if(args.Length==2&&args[0]=="--preflight-fixture") {
      string fixture=args[1],app=Path.Combine(fixture,"Arkdown");Package(app,"1.0.4","old");
      File.Copy(Process.GetCurrentProcess().MainModule.FileName,Path.Combine(app,"Arkdown.exe"),true);
      var manifest=Manifest.Read(app,"1.0.4","Lite");manifest.files[0].bytes=new FileInfo(Path.Combine(app,"Arkdown.exe")).Length;manifest.files[0].sha256=Safety.HashFile(Path.Combine(app,"Arkdown.exe"));
      Safety.WriteJson(Path.Combine(app,Manifest.Relative),manifest);
      Console.WriteLine(Safety.Json.Serialize(new {target=app,package=DeepZip(fixture,"1.0.5","shipping-deep"),relative=DeepFile}));return;
    }
    if(args.Length==2&&args[0]=="--gate-server") {
      using(var gate=new LaunchGate(args[1],r=>r!=null&&r.token==new String('a',64))) {
        Console.WriteLine("ready");Console.Out.Flush();Console.ReadLine();
      }return;
    }
    if(args.Length==4&&args[0]=="--crash") { new PortableTransaction(args[1],args[2],args[3],"1.0.4","1.0.5","Lite",FixtureInventory(args[2])).Apply(n=>{if(n==1)Environment.Exit(17);});return; }
    string sandbox=Path.Combine(Path.GetTempPath(),"ArkdownUpdaterTests-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(sandbox);
    try {
      RestartAckDuringWrite(sandbox);
      LongPaths(sandbox);
      string renameStart=Path.Combine(sandbox,"rename-start"),renameOne=Path.Combine(sandbox,"rename-one"),renameTwo=Path.Combine(sandbox,"rename-two");File.WriteAllText(renameStart,"rename");
      bool allowRestart=false;
      using(var gate=new LaunchGate(sandbox,r=>allowRestart&&r.token=="test")) {
        Reject(()=>new LaunchGate(sandbox,r=>true),"same installation refuses another helper lease");
        foreach(bool expected in new[]{false,true}) {
          allowRestart=expected;
          using(var client=new NamedPipeClientStream(".",LaunchGate.Name(sandbox),PipeDirection.InOut)) {
            client.Connect(2000);byte[] request=System.Text.Encoding.UTF8.GetBytes("{\"token\":\"test\"}\n");client.Write(request,0,request.Length);client.Flush();
            using(var reader=new StreamReader(client))Check(reader.ReadLine()==(expected?"{\"allowed\":true}":"{\"allowed\":false}"),"lease permits only ready restarts "+expected);
          }
        }
      }
      using(var renamed=new LockedFile(renameStart,true,false)) { renamed.Rename(renameOne);Check(File.Exists(renameOne),"first handle rename");renamed.Rename(renameTwo);Check(File.Exists(renameTwo),"second handle rename"); }
      foreach(var p in new[]{"../x","/x","a/../b","a\\b","a:stream","CON.txt","a./x","a//b","portable-data/settings.json",".arkdown-update-pending.json"}) Reject(()=>Safety.Relative(p),"unsafe "+p);
      Check(Safety.Relative("resources/app.asar")=="resources/app.asar","normal relative");
      string target=Path.Combine(sandbox,"target"),stage=Path.Combine(sandbox,"stage"),session=Path.Combine(sandbox,"session");
      Package(target,"1.0.4","old"); Package(stage,"1.0.5","new"); Directory.CreateDirectory(session);
      File.WriteAllText(Path.Combine(target,"personal.md"),"keep"); Directory.CreateDirectory(Path.Combine(target,"portable-data"));File.WriteAllText(Path.Combine(target,"portable-data","settings.json"),"keep-data");
      var transaction=new PortableTransaction(target,stage,session,"1.0.4","1.0.5","Lite",FixtureInventory(stage));
      transaction.Apply(null);
      Check(File.ReadAllText(Path.Combine(target,"Arkdown.exe"))=="new","updated");
      Check(File.ReadAllText(Path.Combine(target,"personal.md"))=="keep","unknown preserved");
      Check(File.ReadAllText(Path.Combine(target,"portable-data","settings.json"))=="keep-data","data preserved");
      Check(Manifest.Read(target,"1.0.5","Lite").files.Count==2,"new manifest");
      var completedJournal=Safety.ReadJson<UpdateJournal>(Path.Combine(session,"journal.json"),32*1024*1024);completedJournal.state="complete";Safety.WriteJson(Path.Combine(session,"journal.json"),completedJournal);
      Check(RecoveryEntry.ExpectedVersion(completedJournal)=="1.0.5","terminal complete recovers actual new version");
      PortableTransaction.Recover(target,session);Check(!File.Exists(Path.Combine(target,PortableTransaction.PendingName)),"terminal complete clears stale marker");
      string t2=Path.Combine(sandbox,"rollback"),s2=Path.Combine(sandbox,"session2");Package(t2,"1.0.4","old");Directory.CreateDirectory(s2);
      Package(stage,"1.0.5","new");bool injected=false;
      try { new PortableTransaction(t2,stage,s2,"1.0.4","1.0.5","Lite",FixtureInventory(stage)).Apply(n=>{if(n==1){injected=true;throw new IOException("injected failure");}});throw new Exception("Expected injected failure"); }catch(IOException e){if(e.Message!="injected failure"){Console.WriteLine(e.ToString());throw;}count++;}Check(injected,"replacement reached before failure");
      Check(File.ReadAllText(Path.Combine(t2,"Arkdown.exe"))=="old","rollback exe"); Check(File.ReadAllText(Path.Combine(t2,"resources","app.asar"))=="old","rollback asar");
      Check(Manifest.Read(t2,"1.0.4","Lite").files.Count==2,"rollback manifest");
      var rolledBack=Safety.ReadJson<UpdateJournal>(Path.Combine(s2,"journal.json"),32*1024*1024);Check(RecoveryEntry.ExpectedVersion(rolledBack)=="1.0.4","terminal rollback selects original version");
      Check(RestartSafety.CanRestoreOriginal(t2,"1.0.4","Lite",false),"unchanged or fully rolled back notes may restore");
      Check(!RestartSafety.CanRestoreOriginal(t2,"1.0.4","Lite",true),"partial installer cannot restore original notes");
      File.WriteAllText(Path.Combine(t2,"Arkdown.exe"),"user-modified");
      Check(!RestartSafety.CanRestoreOriginal(t2,"1.0.4","Lite",false),"unverified original tree cannot restart notes");
      Package(stage,"1.0.5","new");
      Reject(()=>new PortableTransaction(t2,stage,Path.Combine(sandbox,"session3"),"1.0.4","1.0.5","Lite",FixtureInventory(stage)).Apply(null),"modified owned file refused");
      Check(File.ReadAllText(Path.Combine(t2,"Arkdown.exe"))=="user-modified","modified file preserved");
      string zip=Path.Combine(sandbox,"unsafe.zip");using(var z=ZipFile.Open(zip,ZipArchiveMode.Create))using(var w=new StreamWriter(z.CreateEntry("../escape").Open()))w.Write("bad");
      Reject(()=>PackageStage.Extract(zip,Path.Combine(sandbox,"extract"),"1.0.5","Lite"),"zip traversal");
      string zipped=Path.Combine(sandbox,"valid.zip");using(var z=ZipFile.Open(zipped,ZipArchiveMode.Create))foreach(var file in Directory.GetFiles(stage,"*",SearchOption.AllDirectories))z.CreateEntryFromFile(file,file.Substring(stage.Length+1).Replace('\\','/'));
      PackageStage.Extract(zipped,Path.Combine(sandbox,"valid-stage"),"1.0.5","Lite");Check(File.ReadAllText(Path.Combine(sandbox,"valid-stage","Arkdown.exe"))=="new","verified zip extraction");
      string changedStage=Path.Combine(sandbox,"changed-stage"),unchangedTarget=Path.Combine(sandbox,"unchanged-target"),changedSession=Path.Combine(sandbox,"changed-session");
      Package(unchangedTarget,"1.0.4","old");var verifiedZip=PackageStage.Extract(zipped,changedStage,"1.0.5","Lite");
      Package(changedStage,"1.0.5","modified-together-with-manifest");
      Reject(()=>new PortableTransaction(unchangedTarget,changedStage,changedSession,"1.0.4","1.0.5","Lite",verifiedZip).Apply(null),"reject stage content and matching manifest changed after verified ZIP extraction");
      Check(File.ReadAllText(Path.Combine(unchangedTarget,"Arkdown.exe"))=="old","untrusted stage changes no installed program");
      string nested=Path.Combine(sandbox,"nested-payload"),nestedZip=Path.Combine(sandbox,"nested.zip"),nestedStage=Path.Combine(sandbox,"nested-stage");Package(nested,"1.0.5","new");
      string nestedFile=Path.Combine(nested,"resources","components","runtime","fixture.txt");Directory.CreateDirectory(Path.GetDirectoryName(nestedFile));File.WriteAllText(nestedFile,"nested");
      var nestedManifest=Manifest.Read(nested,"1.0.5","Lite");nestedManifest.files.Add(new ManagedFile {path="resources/components/runtime/fixture.txt",bytes=new FileInfo(nestedFile).Length,sha256=Safety.HashFile(nestedFile)});Safety.WriteJson(Path.Combine(nested,Manifest.Relative),nestedManifest);
      using(var z=ZipFile.Open(nestedZip,ZipArchiveMode.Create))foreach(var file in Directory.GetFiles(nested,"*",SearchOption.AllDirectories))z.CreateEntryFromFile(file,file.Substring(nested.Length+1).Replace('\\','/'));
      PackageStage.Extract(nestedZip,nestedStage,"1.0.5","Lite");Check(File.ReadAllText(Path.Combine(nestedStage,"resources","components","runtime","fixture.txt"))=="nested","ZIP creates nested parents without explicit directory entries");
      string nestedTarget=Path.Combine(sandbox,"nested-target");Package(nestedTarget,"1.0.4","old");new PortableTransaction(nestedTarget,nestedStage,Path.Combine(sandbox,"nested-session"),"1.0.4","1.0.5","Lite",FixtureInventory(nestedStage)).Apply(null);
      Check(File.ReadAllText(Path.Combine(nestedTarget,"resources","components","runtime","fixture.txt"))=="nested","upgrade creates newly added nested directories");
      string crash=Path.Combine(sandbox,"crash"),crashSession=Path.Combine(sandbox,".ArkdownUpdate-"+Guid.NewGuid().ToString("N"));Package(crash,"1.0.4","old");
      using(var process=Process.Start(new ProcessStartInfo { FileName=Process.GetCurrentProcess().MainModule.FileName,UseShellExecute=false,CreateNoWindow=true,Arguments="--crash "+Program.Quote(crash)+" "+Program.Quote(stage)+" "+Program.Quote(crashSession) })) {process.WaitForExit();Check(process.ExitCode==17,"abrupt child exit");}
      Check(File.Exists(Path.Combine(crash,PortableTransaction.PendingName)),"durable interrupted marker");
      var recoveryRequest=new HandoffRequest { protocolVersion=1,parentPid=123,token=new String('a',64),target=crash,session=crashSession,package=zipped,bytes=1,sha256=new String('b',64),oldVersion="1.0.4",version="1.0.5",edition="Lite",kind="portable" };
      Safety.WriteJson(Path.Combine(crashSession,"request.json"),recoveryRequest);
      string recoveryExecutable=Path.Combine(crashSession,"Arkdown.Update.exe");
      var manual=RecoveryEntry.Read(recoveryExecutable);Check(manual.recover&&manual.version=="1.0.4","independent recovery entry accepts interrupted transaction");
      string launcher=Path.Combine(crash,"Arkdown.exe"),aside=Path.Combine(sandbox,"temporarily-missing-exe");File.Move(launcher,aside);
      Check(RecoveryEntry.Read(recoveryExecutable).recover,"recovery entry works without application launcher");File.Move(aside,launcher);
      recoveryRequest.target=target;Safety.WriteJson(Path.Combine(crashSession,"request.json"),recoveryRequest);
      Reject(()=>RecoveryEntry.Read(recoveryExecutable),"independent recovery rejects mismatched target");
      recoveryRequest.target=crash;Safety.WriteJson(Path.Combine(crashSession,"request.json"),recoveryRequest);
      PortableTransaction.Recover(crash,crashSession);Check(File.ReadAllText(Path.Combine(crash,"resources","app.asar"))=="old","restart rollback");Check(!File.Exists(Path.Combine(crash,PortableTransaction.PendingName)),"recovery marker cleared");
      Package(stage,"1.0.5","new");
      string lockedRoot=Path.Combine(sandbox,"locked");Package(lockedRoot,"1.0.4","old");using(var locked=new FileStream(Path.Combine(lockedRoot,"resources","app.asar"),FileMode.Open,FileAccess.Read,FileShare.None))
        Reject(()=>new PortableTransaction(lockedRoot,stage,Path.Combine(sandbox,"locked-session"),"1.0.4","1.0.5","Lite",FixtureInventory(stage)).Apply(null),"locked program refuses installation");
      Check(File.ReadAllText(Path.Combine(lockedRoot,"Arkdown.exe"))=="old","lock failure keeps old program");
      Console.WriteLine("PASS "+count+" updater checks");
    } finally { Directory.Delete(@"\\?\"+sandbox,true); }
  }
}
