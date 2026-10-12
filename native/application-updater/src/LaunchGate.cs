using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Security.Cryptography;

namespace Arkdown.Update {
  sealed class LaunchRequest { public int protocolVersion {get;set;} public int pid {get;set;} public string session {get;set;} public string token {get;set;} public string mode {get;set;} public bool notifyBusy {get;set;} }
  sealed class LaunchGate : IDisposable {
    readonly NamedPipeServerStream pipe;readonly Func<LaunchRequest,bool> authorize;readonly Thread thread;volatile bool stopped;
    public static string Name(string target) {
      using(var sha=SHA256.Create())return "arkdown-update-"+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(target).TrimEnd('\\','/').ToLowerInvariant()))).Replace("-","").ToLowerInvariant();
    }
    public LaunchGate(string target,Func<LaunchRequest,bool> authorize) {
      this.authorize=authorize;
      // One continuously owned instance also excludes a second update helper.
      pipe=new NamedPipeServerStream(Name(target),PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous);
      thread=new Thread(Serve) {IsBackground=true};thread.Start();
    }
    void Serve() {
      while(!stopped)try {
        pipe.WaitForConnection();var buffer=new byte[16384];int used=0;bool complete=false;
        while(used<buffer.Length) {
          int n;using(var timeout=new CancellationTokenSource(3000))n=pipe.ReadAsync(buffer,used,buffer.Length-used,timeout.Token).GetAwaiter().GetResult();
          if(n==0)break;used+=n;
          if(Array.IndexOf(buffer,(byte)10,0,used)>=0){complete=true;break;}
        }
        if(complete&&pipe.IsConnected) {
          bool allowed=false;
          try { allowed=authorize(new System.Web.Script.Serialization.JavaScriptSerializer {MaxJsonLength=16384,RecursionLimit=4}.Deserialize<LaunchRequest>(Encoding.UTF8.GetString(buffer,0,used))); }catch { }
          byte[] response=Encoding.UTF8.GetBytes(allowed?"{\"allowed\":true}\n":"{\"allowed\":false}\n");pipe.Write(response,0,response.Length);pipe.Flush();
        }
        if(pipe.IsConnected)pipe.Disconnect();
      }catch {if(!stopped)try{if(pipe.IsConnected)pipe.Disconnect();}catch{} }
    }
    public void Dispose() {stopped=true;pipe.Dispose();if(Thread.CurrentThread!=thread)thread.Join(3500);}
    public static bool IsExpectedProcess(LaunchRequest input,HandoffRequest request) {
      if(input==null||input.token!=request.token||!String.Equals(input.session,request.session,StringComparison.OrdinalIgnoreCase))return false;
      return IsTargetProcess(input,request.target);
    }
    public static bool IsTargetProcess(LaunchRequest input,string target) {
      if(input==null||input.protocolVersion!=1||(input.mode!="arkdown"&&input.mode!="arknote"))return false;
      try {using(var process=Process.GetProcessById(input.pid))return !process.HasExited&&String.Equals(process.MainModule.FileName,Path.Combine(target,input.mode=="arkdown"?"Arkdown.exe":"Arknote.exe"),StringComparison.OrdinalIgnoreCase);}catch{return false;}
    }
  }
}
