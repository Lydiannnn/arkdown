using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Arkdown.Update {
  // All callers are failure branches. No file I/O, request contents, exception
  // messages or source-file stack locations enter this optional protocol record.
  static class FailureDiagnostics {
    const string Key="Arkdown.Update.Failure.";
    [ThreadStatic] static Dictionary<string,object> first;
    static object Get(Exception error,string name) { return error.Data[Key+name]; }
    static void Put(Exception error,string name,object value) { if(value!=null&&Get(error,name)==null)error.Data[Key+name]=value; }
    public static void TryAnnotate(Exception error,string phase,string operation,string path) {
      try { Put(error,"phase",phase);Put(error,"operation",operation);Put(error,"path",path); }catch{}
    }
    public static void TryNative(Exception error,string operation,int? code,string reason) {
      try { Put(error,"operation",operation);Put(error,"nativeErrorCode",code);Put(error,"nativeCodeSource",code.HasValue?"GetLastError":null);Put(error,"validationReason",reason); }catch{}
    }
    public static void TryOpen(Exception error,string path,uint access,uint share,uint creation,uint flags) {
      try { Put(error,"path",path);Put(error,"access",access);Put(error,"share",share);Put(error,"creation",creation);Put(error,"flags",flags); }catch{}
    }
    static string Limit(string value,int max) { return value==null?null:(value.Length<=max?value:value.Substring(0,max)); }
    static string Stack(Exception error) {
      var result=new StringBuilder();var frames=new StackTrace(error,false).GetFrames();
      if(frames!=null)foreach(var frame in frames) {
        var method=frame.GetMethod();if(method==null)continue;
        string owner=method.DeclaringType==null?null:method.DeclaringType.FullName;
        result.Append("at ").Append(owner).Append('.').Append(method.Name).Append("()\n");
        if(result.Length>=3072)break;
      }
      return Limit(result.ToString(),3072);
    }
    public static bool IsDispose(Exception error) {
      try { var frames=new StackTrace(error,false).GetFrames();if(frames!=null)foreach(var f in frames)if(f.GetMethod()!=null&&f.GetMethod().Name=="Dispose")return true; }catch{}
      return false;
    }
    static Dictionary<string,object> Snapshot(Exception error) {
      var r=new Dictionary<string,object>();
      foreach(string key in new[]{"phase","operation","path","access","share","creation","flags","nativeErrorCode","nativeCodeSource","validationReason"})r[key]=Get(error,key);
      r["path"]=Limit(r["path"] as string,32760);r["exceptionType"]=Limit(error.GetType().FullName,160);r["hresult"]=error.HResult;
      if(r["nativeErrorCode"]==null&&r["validationReason"]==null) {
        var native=error as Win32Exception;
        if(native!=null) {r["nativeErrorCode"]=native.NativeErrorCode;r["nativeCodeSource"]="Win32Exception";}
        else if(error is IOException&&(unchecked((uint)error.HResult)&0xffff0000u)==0x80070000u) {r["nativeErrorCode"]=error.HResult&0xffff;r["nativeCodeSource"]="HResult";}
      }
      r["primaryStack"]=Stack(error);return r;
    }
    public static void Remember(Exception error,string phase,string operation,string path) {
      try { TryAnnotate(error,phase,operation,path);if(first==null) {first=(Get(error,"primary") as Dictionary<string,object>)??Snapshot(error);if(first["phase"]==null)first["phase"]=Get(error,"phase");} }catch{}
    }
    public static void RememberRelative(Exception error,string phase,string operation,string root,string relative) {
      try {Remember(error,phase,operation,root+"\\"+relative.Replace('/','\\'));}catch{}
    }
    // Called only by Extract's outer failure catch. Its finally consumes the
    // thread-local slot even if an exception has a hostile Data implementation.
    public static void Consume(Exception terminal,string phase,string operation,string path) {
      try { TryAnnotate(terminal,phase,operation,path);if(first!=null)Put(terminal,"primary",first); }catch{}
      finally { first=null; }
    }
    public static void Transfer(Exception primary,Exception terminal) {
      try { Put(terminal,"primary",Get(primary,"primary")??Snapshot(primary)); }catch{}
    }
    static string CleanRoot(string value) {
      if(String.IsNullOrEmpty(value)||value.Length>32760)return null;
      value=value.Replace('/','\\');if(value.StartsWith(@"\\?\"))value=value.Substring(4);
      if(value.Length<3||value[1]!=':'||value[2]!='\\'||value.IndexOf(':',2)>=0||value.IndexOf('\0')>=0)return null;
      return value.TrimEnd('\\');
    }
    static bool Alias(Dictionary<string,object> record,string path,string root,string scope) {
      root=CleanRoot(root);if(root==null)return false;
      if(String.Equals(path,root,StringComparison.OrdinalIgnoreCase)) {record["pathScope"]=scope;record["pathPrecision"]="root-only";return true;}
      if(scope=="package"||!path.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))return false;
      string relative=path.Substring(root.Length+1).Replace('\\','/');
      if(relative.Length>2000)return false;
      // Reject traversal/control/drive text without consulting the filesystem.
      foreach(string part in relative.Split('/'))if(part.Length==0||part=="."||part==".."||part.IndexOf(':')>=0)return false;
      foreach(char c in relative)if(Char.IsControl(c)||"<>\"|?*".IndexOf(c)>=0)return false;
      record["pathScope"]=scope;record["pathPrecision"]="exact";record["relativePath"]=relative;return true;
    }
    public static Dictionary<string,object> Build(Exception terminal,HandoffRequest request) {
      try {
        var primary=Get(terminal,"primary") as Dictionary<string,object>;
        var source=primary??Snapshot(terminal);var r=new Dictionary<string,object>();
        r["schemaVersion"]=1;r["origin"]="helper";
        foreach(string key in new[]{"phase","operation","exceptionType","nativeErrorCode","nativeCodeSource","hresult","access","share","creation","flags","validationReason","primaryStack"})r[key]=source[key];
        r["phase"]=r["phase"]??Get(terminal,"phase")??"helper.validate";
        r["terminalStack"]=primary==null?null:Stack(terminal);
        r["pathScope"]="unknown";r["relativePath"]=null;r["pathPrecision"]="unknown";r["ancestorLevelsAboveSession"]=null;
        string path=CleanRoot(source["path"] as string);
        if(path!=null&&request!=null) {
          string session=CleanRoot(request.session);
          if(!Alias(r,path,request.package,"package")&&!Alias(r,path,session==null?null:session+"\\stage","stage")&&!Alias(r,path,session,"session")&&!Alias(r,path,request.target,"target")&&session!=null&&session.StartsWith(path+"\\",StringComparison.OrdinalIgnoreCase)) {
            int levels=session.Substring(path.Length+1).Split('\\').Length;
            if(levels<=128) {r["pathScope"]="ancestor";r["pathPrecision"]="exact";r["ancestorLevelsAboveSession"]=levels;}
          }
        }
        // Budget the final escaped JSON, preserving codes and context first.
        while(Safety.Json.Serialize(r).Length>8192) {
          string a=r["primaryStack"] as string,b=r["terminalStack"] as string;
          if(!String.IsNullOrEmpty(a)||!String.IsNullOrEmpty(b)) {r["primaryStack"]=Limit(a,(a??"").Length/2);r["terminalStack"]=Limit(b,(b??"").Length/2);}
          else {r["relativePath"]=null;r["pathPrecision"]="unknown";if(Safety.Json.Serialize(r).Length>8192)return null;}
        }
        return r;
      }catch {return null;}
    }
    public static string ErrorResponse(Exception error,string message,HandoffRequest request) {
      try {
        if(Get(error,"phase")==null&&Get(error,"primary")==null)return null;
        var diagnostic=Build(error,request);if(diagnostic==null)return null;
        string text=Safety.Json.Serialize(new {type="error",message=message,diagnostic=diagnostic});
        return text.Length<16384?text:null;
      }catch{return null;}
    }
  }
}
