using System;
using System.Collections.Generic;
using System.Collections;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using Arkdown.Update;

// Reflection keeps this harness compilable against the pre-diagnostic baseline
// so the first assertion can establish RED without changing production inputs.
static class DiagnosticTests {
  sealed class HostileDataException : Exception { public override IDictionary Data {get {throw new InvalidOperationException("diagnostic getter failed");}} }
  static readonly Type Diagnostics=typeof(Safety).Assembly.GetType("Arkdown.Update.FailureDiagnostics");
  static int checks;
  static void Check(bool value,string message) { if(!value)throw new Exception(message);checks++; }
  static object Call(string name,params object[] args) { return Diagnostics.GetMethod(name,BindingFlags.Public|BindingFlags.Static).Invoke(null,args); }
  static Dictionary<string,object> Record(Exception error) {
    return (Dictionary<string,object>)Call("Build",error,new HandoffRequest {session=@"C:\private-user\.ArkdownUpdate-session",target=@"C:\private-user\Arkdown",package=@"C:\private-user\secret-download.zip"});
  }
  static Exception Thrown(Exception error) { try {throw error;}catch(Exception caught){return caught;} }
  static void Main() {
    try { Run(); }
    catch(Exception error) { Console.WriteLine("FAIL "+error.GetType().Name+": "+error.Message);Environment.ExitCode=1; }
  }
  static void Run() {
    Check(Diagnostics!=null,"preflight diagnostics are available");
    var native=Thrown(new Win32Exception(32));
    Call("TryNative",native,"CreateFileW",(int?)32,null);
    Call("TryOpen",native,@"C:\private-user\.ArkdownUpdate-session\stage\resources\app.asar",0x80000000u,1u,3u,0x00200000u);
    Call("TryAnnotate",native,"stage.verify.open",null,null);
    var r=Record(native);
    Check((int)r["nativeErrorCode"]==32&&(string)r["nativeCodeSource"]=="GetLastError","saved native failure survives later context");
    Check((string)r["pathScope"]=="stage"&&(string)r["relativePath"]=="resources/app.asar","exact stage file retained");
    Check((string)r["phase"]=="stage.verify.open"&&(uint)r["share"]==1u,"phase and original share retained");
    Check(!Safety.Json.Serialize(r).Contains("private-user"),"absolute paths are not serialized");
    Console.WriteLine("DIAGNOSTIC_JSON "+Safety.Json.Serialize(r));
    var generic=Thrown(new IOException("secret C:\\private-user https://private.invalid/token",unchecked((int)0x80131620)));
    r=Record(generic);Check(r["nativeErrorCode"]==null,"non-Win32 HResult is not truncated to a native code");
    r=Record(Thrown(new IOException("private",unchecked((int)0x80070020))));
    Check((int)r["nativeErrorCode"]==32&&(string)r["nativeCodeSource"]=="HResult","Win32 facility is explicitly derived");
    var validation=Thrown(new InvalidDataException("Path identity changed"));
    Call("TryNative",validation,"GetFinalPathNameByHandleW",null,"path-identity");
    r=Record(validation);Check(r["nativeErrorCode"]==null&&(string)r["validationReason"]=="path-identity","validation failure never invents an API code");
    var ancestor=Thrown(new Win32Exception(5));Call("TryOpen",ancestor,@"C:\private-user",0x80u,3u,3u,0x02200000u);
    r=Record(ancestor);Check((string)r["pathScope"]=="ancestor"&&(int)r["ancestorLevelsAboveSession"]==1&&r["relativePath"]==null,"ancestor is counted without leaking its name");
    var enumeration=Thrown(new IOException("secret"));Call("TryAnnotate",enumeration,"stage.enumerate","Directory.GetFiles",@"C:\private-user\.ArkdownUpdate-session\stage");
    r=Record(enumeration);Check((string)r["pathPrecision"]=="root-only"&&r["relativePath"]==null,"enumeration failure does not pretend a known child path");
    Call("Remember",native,"stage.extract.flush","FileStream.Flush",null);
    var terminal=Thrown(new IOException("dispose private"));Call("Consume",terminal,"stage.finalize",null,null);
    r=Record(terminal);Check((string)r["exceptionType"]=="System.ComponentModel.Win32Exception"&&(int)r["nativeErrorCode"]==32,"primary failure survives disposal replacement");
    Check(r["terminalStack"]!=null,"terminal stack retained separately");
    var next=Thrown(new InvalidDataException("next"));Call("Consume",next,"stage.finalize",null,null);
    r=Record(next);Check((string)r["exceptionType"]=="System.IO.InvalidDataException"&&r["nativeErrorCode"]==null,"consumed snapshot cannot leak into a later invocation");
    var longPath=Thrown(new IOException("not serialized"));Call("TryAnnotate",longPath,"helper.validate",null,@"C:\private-user\.ArkdownUpdate-session\"+new string('x',10000));
    r=Record(longPath);Check(Safety.Json.Serialize(r).Length<=8192,"final diagnostic JSON obeys its character limit");
    Check(!Safety.Json.Serialize(r).Contains("secret-download"),"package basename and exception messages are not serialized");
    var packagePath=Thrown(new IOException("package"));Call("TryAnnotate",packagePath,"stage.open",null,@"C:\private-user\.ArkdownUpdate-session\private-name.zip");
    r=(Dictionary<string,object>)Call("Build",packagePath,new HandoffRequest {session=@"C:\private-user\.ArkdownUpdate-session",package=@"C:\private-user\.ArkdownUpdate-session\private-name.zip"});
    Check((string)r["pathScope"]=="package"&&r["relativePath"]==null,"package alias takes precedence over its containing session");
    var hostile=new HostileDataException();Call("TryAnnotate",hostile,"helper.validate",null,null);
    Check(Record(hostile)==null,"hostile exception Data cannot mask the original failure");
    Check(Call("ErrorResponse",new IOException("later failure"),"original UI",new HandoffRequest())==null,"post-preflight errors retain the original response shape");
    Console.WriteLine("PASS "+checks+" failure diagnostic checks");
  }
}
