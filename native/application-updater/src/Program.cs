using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Drawing;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Forms;

namespace Arkdown.Update {
  sealed class HandoffRequest {
    public int protocolVersion {get;set;} public int parentPid {get;set;} public string token {get;set;} public string target {get;set;}
    public string session {get;set;} public string package {get;set;} public long bytes {get;set;} public string sha256 {get;set;}
    public string oldVersion {get;set;} public string version {get;set;} public string edition {get;set;} public string kind {get;set;}
    public bool recover {get;set;}
  }
  sealed class Command { public string type {get;set;} public string token {get;set;} public string[] documents {get;set;} public bool restoreArknote {get;set;} public string message {get;set;} }
  sealed class RestartAck { public int protocolVersion {get;set;} public string token {get;set;} public string version {get;set;} public int pid {get;set;} public string mode {get;set;} }
  sealed class UpdateForm : Form {
    readonly Label heading=new Label(),body=new Label(),notice=new Label();readonly ProgressBar progress=new ProgressBar();readonly Button close=new Button();bool allowed,launchNotice;
    public UpdateForm() {
      Text="Arkdown 更新";Font=new Font("Microsoft YaHei UI",10);ClientSize=new Size(480,210);StartPosition=FormStartPosition.CenterScreen;FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;MinimizeBox=false;BackColor=Color.White;
      heading.SetBounds(24,22,432,32);heading.Font=new Font(Font.FontFamily,13,FontStyle.Bold);heading.Text="正在更新 Arkdown";
      body.SetBounds(24,66,432,70);progress.SetBounds(24,146,432,10);progress.Style=ProgressBarStyle.Marquee;
      close.SetBounds(350,158,106,32);close.Text="关闭";close.BackColor=Color.FromArgb(65,132,197);close.ForeColor=Color.White;close.FlatStyle=FlatStyle.Flat;close.Visible=false;close.Click+=(s,e)=>Application.Exit();
      Controls.AddRange(new Control[]{heading,body,progress,close});FormClosing+=(s,e)=>{ if(!allowed)e.Cancel=true; };
    }
    public void Status(string text,bool failed) { BeginInvoke((Action)(()=> { body.Text=text;if(!Visible)Show();if(failed) { heading.Text="更新尚未完成";progress.Visible=false;close.Visible=true;allowed=true; } })); }
    public void Done() { BeginInvoke((Action)(()=> { allowed=true;if(!launchNotice){Application.Exit();return;}heading.Text="更新操作已结束";body.Text="请重新打开刚才选择的文档或便签。";progress.Visible=false;close.Visible=true;Reveal(); })); }
    public void ShowLaunchNotice() { BeginInvoke((Action)(()=> {
      launchNotice=true;ClientSize=new Size(480,260);notice.SetBounds(24,170,432,38);notice.Text="暂未打开刚才选择的文档或便签。请等待更新结束后重新打开。";Controls.Add(notice);close.Top=218;Reveal();
    })); }
    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(value&&Visible); }
    public void Reveal() { base.SetVisibleCore(true); }
    public bool ConfirmRecovery(string version) {
      bool accepted=false;using(var ready=new ManualResetEvent(false)) {
        BeginInvoke((Action)(()=> {
          Reveal();heading.Text="恢复中断的更新";body.Text="将恢复 Arkdown "+version+" 的程序文件，并保留用户文档和设置。请先正常关闭该目录中的 Arkdown 与 Arknote。";
          progress.Visible=false;close.Visible=true;allowed=true;
          var confirm=new Button { Text="恢复并重启",BackColor=Color.FromArgb(65,132,197),ForeColor=Color.White,FlatStyle=FlatStyle.Flat };
          confirm.SetBounds(220,158,120,32);Controls.Add(confirm);
          confirm.Click+=(s,e)=>{accepted=true;allowed=false;close.Visible=false;confirm.Dispose();progress.Visible=true;ready.Set();};
        }));
        ready.WaitOne();return accepted;
      }
    }
    public void Display(string text,bool failed) { BeginInvoke((Action)(()=>{Reveal();body.Text=text;if(failed){heading.Text="更新尚未完成";progress.Visible=false;close.Visible=true;allowed=true;}})); }
  }
  static class Program {
    static VerifiedPackage verifiedPackage;
    static readonly object sync=new object();static UpdateForm form;static bool committed,revoked,applying,manualRecovery,installerStarted;static volatile bool restartAllowed;static LaunchGate launchGate;static Process parent;static DateTime parentStart;static HandoffRequest request;static Command commit;static DirectoryPins pins;static LockedFile package,sessionLock;
    [STAThread] static void Main(string[] args) {
      Safety.EnableLongPaths();
      if(args.Length>0&&args[0]=="--installer-finalize") { Environment.ExitCode=InstallerFinalize.Run(args);return; }
      // A Windows GUI helper has redirected pipes, not a console. Encoding setters
      // call console APIs and fail before the handshake when no console exists.
      if(args.Length>0) {
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)) { AutoFlush=true });
      }
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      form=new UpdateForm();var handle=form.Handle;
      new Thread(()=>Run(args)) { IsBackground=true }.Start();Application.Run(form);
    }
    static void Send(string type,string message) { lock(Console.Out) { Console.Out.WriteLine(Safety.Json.Serialize(new { type=type,message=message }));Console.Out.Flush(); } }
    static void SendError(Exception error) {
      string message=ErrorMessage(error),response=FailureDiagnostics.ErrorResponse(error,message,request);
      if(response==null) {Send("error",message);return;}
      lock(Console.Out) {Console.Out.WriteLine(response);Console.Out.Flush();}
    }
    static string Line(int max) { var b=new StringBuilder();int c;while((c=Console.In.Read())!=-1&&c!='\n') { if(b.Length>=max)throw new InvalidDataException("Oversized update command");if(c!='\r')b.Append((char)c); }return c==-1&&b.Length==0?null:b.ToString(); }
    static void Run(string[] args) {
      try {
        if(args.Length==0) {
          manualRecovery=true;request=RecoveryEntry.Read(Application.ExecutablePath);
          try {Validate();}catch(Exception error) {FailureDiagnostics.TryAnnotate(error,"helper.validate",null,null);throw;}
          commit=Safety.ReadJson<Command>(Path.Combine(request.session,"commit.json"),131072);ValidateDocuments(commit);
          if(!form.ConfirmRecovery(request.version)){Release();form.Done();return;}
          commit.token=request.token;Safety.WriteJson(Path.Combine(request.session,"commit.json"),commit);committed=true;ApplyAfterExit();return;
        }
        if(args.Length!=1||args[0]!="--stdio")throw new InvalidDataException("Invalid helper invocation");
        string first=Line(16384);request=Safety.Json.Deserialize<HandoffRequest>(first??"");
        try {Validate();}catch(Exception error) {FailureDiagnostics.TryAnnotate(error,"helper.validate",null,null);throw;}
        if(request.kind=="portable"&&!request.recover)verifiedPackage=PackageStage.Extract(request.package,Path.Combine(request.session,"stage"),request.version,request.edition);
        Send("ready",null);
        string line;while((line=Line(131072))!=null) {
          Command c=Safety.Json.Deserialize<Command>(line);if(c==null||c.token!=request.token)throw new InvalidDataException("Invalid command token");
          lock(sync) {
            if(c.type=="notes-state") { Console.Out.WriteLine(Safety.Json.Serialize(new {type="notes",running=Processes.Count(request.target,"Arknote",0)>0}));Console.Out.Flush();continue; }
            if(c.type=="wait-notes-exit") {
              for(int i=0;Processes.Count(request.target,"Arknote",0)>0;i++) {if(i>=300)throw new IOException("便签未能正常退出，更新已停止。请检查便签保存状态。");Thread.Sleep(100);}
              Send("notes-stopped",null);continue;
            }
            if(c.type=="revoke") {
              if(applying) { Send("error","更新已开始替换文件，不能再取消。");continue; }
              revoked=true;Release();Send("revoked",null);
              if(!String.IsNullOrEmpty(c.message))form.Display(c.message,true);else form.Done();return;
            }
            if(c.type!="commit"||committed||revoked)throw new InvalidDataException("Invalid update state");
            ValidateDocuments(c);
            Safety.WriteJson(Path.Combine(request.session,"commit.json"),c);
            commit=c;committed=true;Send("committed",null);new Thread(ApplyAfterExit) { IsBackground=true }.Start();
          }
        }
        lock(sync)if(!committed) { revoked=true;Release();form.Done(); }
      } catch(Exception e) { SendError(e);lock(sync) { if(!committed){Release();if(manualRecovery)form.Display(ErrorMessage(e),true);else form.Done();}else form.Display(ErrorMessage(e),true); } }
    }
    static void ValidateDocuments(Command c) { if(c==null||c.documents==null||c.documents.Length>128||c.documents.Any(p=>p==null||p.Length>32760||!Path.IsPathRooted(p)||p.IndexOf('\0')>=0))throw new InvalidDataException("Invalid restart documents"); }
    static void Validate() {
      if(request==null||request.protocolVersion!=1||request.parentPid<=0||request.token==null||!System.Text.RegularExpressions.Regex.IsMatch(request.token,"^[a-f0-9]{64}$")||request.bytes<=0||request.bytes>32L*1024*1024*1024||request.sha256==null||!System.Text.RegularExpressions.Regex.IsMatch(request.sha256,"^[a-f0-9]{64}$"))throw new InvalidDataException("Invalid update request");
      Safety.Version(request.oldVersion);Safety.Version(request.version);if(request.edition!="Full"&&request.edition!="Lite")throw new InvalidDataException("Invalid edition");if(request.kind!="portable"&&request.kind!="installer")throw new InvalidDataException("Invalid package kind");
      request.target=Safety.Full(request.target);request.session=Safety.Full(request.session);request.package=Safety.Full(request.package);
      Guid id;string sessionName=Path.GetFileName(request.session);
      if(!sessionName.StartsWith(".ArkdownUpdate-")||!Guid.TryParseExact(sessionName.Substring(15),"N",out id)||!String.Equals(Path.GetDirectoryName(request.session),Path.GetDirectoryName(request.target),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Invalid session location");
      if(request.package.StartsWith(request.target+"\\",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Package must be outside the installation");
      if(!manualRecovery) {
        parent=Process.GetProcessById(request.parentPid);parentStart=parent.StartTime;
        if(!String.Equals(parent.MainModule.FileName,Path.Combine(request.target,"Arkdown.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Parent application mismatch");
      }
      if(Processes.Count(request.target,"Arkdown",manualRecovery?0:request.parentPid)>0||manualRecovery&&Processes.Count(request.target,"Arknote",0)>0)throw new IOException("当前安装目录还有程序在运行。请先正常关闭这些 Arkdown 和 Arknote 窗口，再重试更新或恢复。");
      pins=new DirectoryPins();pins.Pin(request.target,false);pins.Pin(request.session,false);pins.Pin(Path.GetDirectoryName(request.package),false);
      string lockPath=Path.Combine(request.session,"owner.lock");sessionLock=new LockedFile(lockPath,true,!Safety.FileExists(lockPath));
      launchGate=new LaunchGate(request.target,input=> {
        if(input!=null&&input.notifyBusy&&LaunchGate.IsTargetProcess(input,request.target))form.ShowLaunchNotice();
        return restartAllowed&&LaunchGate.IsExpectedProcess(input,request);
      });
      if((request.kind=="installer")!=Safety.FileExists(Path.Combine(request.target,".arkdown-installation.ini")))throw new InvalidDataException("Installation type changed");
      if(request.recover) {
        var marker=Safety.ReadJson<PendingUpdate>(Path.Combine(request.target,PortableTransaction.PendingName),1024);
        var journal=Safety.ReadJson<UpdateJournal>(Path.Combine(request.session,"journal.json"),32*1024*1024);
        if(request.kind!="portable"||marker.schemaVersion!=1||marker.session!=Path.GetFileName(request.session)||journal.schemaVersion!=1||journal.target!=request.target||RecoveryEntry.ExpectedVersion(journal)!=request.version||journal.edition!=request.edition||(journal.oldVersion!=request.oldVersion&&journal.newVersion!=request.oldVersion))throw new InvalidDataException("Invalid recovery identity");
      } else {
        Manifest.Read(request.target,request.oldVersion,request.edition);
        if(Safety.FileExists(Path.Combine(request.target,PortableTransaction.PendingName)))throw new InvalidDataException("Previous update needs recovery");
        if(Safety.FileExists(Path.Combine(request.target,".arkdown-installer-update.ini")))throw new IOException("上次安装尚未确认完成，请先重新运行官方安装包修复程序。");
        package=new LockedFile(request.package,false,false);Safety.Verify(package,new ManagedFile {path="update package",bytes=request.bytes,sha256=request.sha256});
      }
      // Establish writability without touching an existing application file.
      string probe=Path.Combine(request.target,".arkdown-update-probe-"+Guid.NewGuid().ToString("N"));using(var f=new LockedFile(probe,true,true))f.Rename(Path.Combine(request.session,"probe"));
      Safety.WriteJson(Path.Combine(request.session,"request.json"),request);
      if(!request.recover) {
        string instructions=Path.Combine(request.session,"README-恢复更新.txt");
        using(var file=new FileStream(Safety.IoPath(instructions),FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(file,new UTF8Encoding(false)))writer.Write("若免安装版升级中断，且 Arkdown.exe 无法打开：\r\n1. 正常关闭原目录的 Arkdown 与 Arknote。\r\n2. 双击本目录的 Arkdown.Update.exe，确认恢复程序。\r\n请保留此目录及备份，勿用于其他安装目录。安装版请重新运行官方安装包。");
      }
    }
    static bool ParentAlive() { try { return !parent.HasExited&&parent.StartTime==parentStart; }catch{return false;} }
    static void ApplyAfterExit() {
      try {
        var deadline=DateTime.UtcNow.AddSeconds(90);while(ParentAlive()) { lock(sync)if(revoked)return;if(DateTime.UtcNow>deadline)throw new IOException("Arkdown 未能退出。更新尚未替换文件，请关闭剩余窗口后重试。");Thread.Sleep(100); }
        lock(sync) { if(revoked)return;applying=true; }
        form.Display("正在检查程序是否已完全退出…",false);
        for(int i=0;Processes.Count(request.target,"Arkdown",0)+Processes.Count(request.target,"Arknote",0)>0;i++) { if(i>=300)throw new IOException("仍有当前安装目录的程序在运行。更新没有强制关闭它们，请正常退出后重试。");Thread.Sleep(100); }
        Thread.Sleep(1200);if(Processes.Count(request.target,"Arkdown",0)+Processes.Count(request.target,"Arknote",0)>0)throw new IOException("程序在安装前重新启动，更新已停止。");
        if(request.recover) {
          form.Display("正在恢复上次更新前的程序文件；用户文档和设置会保留。",false);
          PortableTransaction.Recover(request.target,request.session);
        } else if(request.kind=="portable") {
          Safety.Verify(package,new ManagedFile {path="update package",bytes=request.bytes,sha256=request.sha256});
          form.Display("正在替换程序文件；用户文档和设置会保留。",false);
          new PortableTransaction(request.target,Path.Combine(request.session,"stage"),request.session,request.oldVersion,request.version,request.edition,verifiedPackage).Apply(null);
        } else {
          Safety.Verify(package,new ManagedFile {path="update package",bytes=request.bytes,sha256=request.sha256});
          form.Display("正在运行安装程序。请保持本窗口开启。",false);
          string guard=Path.Combine(request.target,".arkdown-installer-update.ini");
          using(var file=new FileStream(Safety.IoPath(guard),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
            byte[] bytes=Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("[ArkdownUpdate]\r\nSchema=1\r\nTarget="+request.target+"\r\nSession="+request.session+"\r\n")).ToArray();file.Write(bytes,0,bytes.Length);file.Flush(true);
          }
          var info=new ProcessStartInfo {FileName=request.package,UseShellExecute=false,CreateNoWindow=true,Arguments=String.Join(" ",new[]{"/SILENT","/SP-","/NORESTART","/NOCLOSEAPPLICATIONS","/NORESTARTAPPLICATIONS","/RESTARTEXITCODE=8",Quote("/DIR="+request.target),Quote("/LOG="+Path.Combine(request.session,"installer.log"))})};
          using(var installer=Process.Start(info)) { installerStarted=true;installer.WaitForExit();if(installer.ExitCode!=0)throw new IOException(installer.ExitCode==8?"安装需要重新启动 Windows 才能完成。请先保存其他应用中的工作，再自行重启。":"安装器未能完成更新。请查看安装日志或重新运行官方安装包；不要删除用户数据。"); }
        }
        if(Safety.FileExists(Path.Combine(request.target,".arkdown-installer-update.ini")))throw new IOException("安装完成状态未能确认，请重新运行官方安装包修复后再打开程序。");
        Manifest.Read(request.target,request.version,request.edition);restartAllowed=true;form.Display("正在启动新版本并确认运行状态…",false);
        StartApplication("Arkdown",commit.documents);WaitAck("arkdown");
        if(commit.restoreArknote) { StartApplication("Arknote",new[]{"--arkdown-autostart"});WaitAck("arknote"); }
        if(request.kind=="portable"&&!request.recover)PortableTransaction.FinishMarker(request.target,request.session,"complete");
        Send("done",null);Release();form.Done();
      } catch(Exception e) {
        bool restore=commit!=null&&commit.restoreArknote&&RestartSafety.CanRestoreOriginal(request.target,request.oldVersion,request.edition,installerStarted);
        if(!installerStarted&&request.kind=="installer") {
          string guard=Path.Combine(request.target,".arkdown-installer-update.ini");
          if(Safety.FileExists(guard))try{using(var held=new LockedFile(guard,true,false))held.Rename(Path.Combine(request.session,"unused-installer-guard.ini"));}catch{restore=false;}
        }
        Release();string message=ErrorMessage(e);
        if(restore)try {
          if(Processes.Count(request.target,"Arknote",0)==0)using(var note=Process.Start(new ProcessStartInfo {FileName=Path.Combine(request.target,"Arknote.exe"),WorkingDirectory=request.target,UseShellExecute=false,Arguments="--arkdown-autostart"})) {}
        }catch {message+=" 便签未能重新启动，请在确认程序可正常运行后手动打开 Arknote。";}
        Send("error",message);form.Display(message,true);
      }
    }
    static void StartApplication(string name,IEnumerable<string> documents) {
      string ack=Path.Combine(request.session,name.ToLowerInvariant()+"-ready.json");if(Safety.FileExists(ack))using(var previous=new LockedFile(ack,true,false))previous.Rename(Path.Combine(request.session,"previous-ack-"+Guid.NewGuid().ToString("N")+".json"));
      var args=new List<string>(documents);args.Add("--arkdown-update-session="+request.session);args.Add("--arkdown-update-token="+request.token);
      using(var p=Process.Start(new ProcessStartInfo { FileName=Path.Combine(request.target,name+".exe"),WorkingDirectory=request.target,UseShellExecute=false,Arguments=String.Join(" ",args.Select(Quote)) }))if(p==null)throw new IOException("新版本未能启动，请手动打开 Arkdown。");
    }
    static void WaitAck(string mode) {
      string file=Path.Combine(request.session,mode+"-ready.json");for(int i=0;i<600;i++) {
        if(Safety.FileExists(file)) {
          RestartAck ack;
          try { ack=Safety.ReadJson<RestartAck>(file,4096); }
          catch(System.ComponentModel.Win32Exception e) {
            // The restart process creates this path before write/fsync/close.
            // Keep the strict read lock, but wait within the existing deadline
            // when the producer (or a scanner) still has a write handle open.
            if(e.NativeErrorCode!=32&&e.NativeErrorCode!=33)throw;
            Thread.Sleep(100);continue;
          }
          if(ack==null||ack.protocolVersion!=1||ack.token!=request.token||ack.version!=request.version||ack.mode!=mode)throw new IOException("新版本启动确认不匹配，请检查安装目录。");
          using(var p=Process.GetProcessById(ack.pid))if(!p.HasExited&&String.Equals(p.MainModule.FileName,Path.Combine(request.target,mode=="arkdown"?"Arkdown.exe":"Arknote.exe"),StringComparison.OrdinalIgnoreCase))return;
          throw new IOException("新版本在启动确认时已退出，请重新打开 Arkdown 检查。");
        }Thread.Sleep(100);
      }throw new IOException("更新文件已写入，但未收到新版本启动确认。请手动打开 Arkdown 检查；更新备份仍保留。");
    }
    public static string Quote(string arg) { var b=new StringBuilder("\"");int slashes=0;foreach(char c in arg){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString(); }
    static string ErrorMessage(Exception e) { string text=e.Message;if(text.Length>0&&text[0]>127)return text;return "更新未能完成。程序文件可能被占用，或更新包校验未通过。请保留现有文件，重新下载更新；必要时使用官方安装包修复。"; }
    static void Release() { lock(sync) { if(launchGate!=null){launchGate.Dispose();launchGate=null;}if(package!=null){package.Dispose();package=null;}if(sessionLock!=null){sessionLock.Dispose();sessionLock=null;}if(pins!=null){pins.Dispose();pins=null;} } }
  }
}
