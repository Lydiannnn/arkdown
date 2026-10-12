using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Text.RegularExpressions;

namespace Arkdown.Update {
  // Installer-only protocol. The obsolete object is fixed here, never supplied
  // by the caller. Preparation writes only a startup guard; deletion is post-copy.
  static class InstallerFinalize {
    internal const string ManualRelative="resources/components/pandoc/MANUAL.html";
    internal const long ManualBytes=426772;
    internal const string ManualSha256="b882985d7262ed342636acb8c33e6793c9f21fd92caf2eae9b50d590178a121b";
    const string PandocManifestSha256="526dea6b7431aec7479f696a24ee0a0ac053f80610b4d436869282764a035ee5";
    internal const string GuardName=".arkdown-installer-update.ini";
    sealed class Failure : Exception { public readonly int Code; public Failure(int code,string message):base(message){Code=code;} }
    static bool Hash(string value) {return value!=null&&Regex.IsMatch(value,"^[a-f0-9]{64}$");}
    static bool Missing(Win32Exception error) {return error.NativeErrorCode==2||error.NativeErrorCode==3;}
    internal static bool KnownManual(long bytes,string sha256) {return bytes==ManualBytes&&sha256==ManualSha256;}

    internal static int Run(string[] args) {
      try {
        if(args.Length!=7||args[0]!="--installer-finalize"||!new[]{"prepare","migrate","complete"}.Contains(args[1])
          ||!Hash(args[3])||(args[5]!="Full"&&args[5]!="Lite")||(args[1]=="prepare"?args[6]!="-":!Hash(args[6])))return 10;
        Safety.Version(args[4]);string root=Safety.Full(args[2]);
        using(var pins=new DirectoryPins()) {
          pins.Pin(root,args[1]=="prepare");
          if(args[1]=="prepare")return Prepare(root)?0:2;
          using(var guard=new LockedFile(Path.Combine(root,GuardName),true,false)) {
            ReadGuard(guard,root);
            if(Safety.Hash(guard.Stream)!=args[6])throw new Failure(24,"Guard identity changed");
            VerifyInstalled(root,args[3],args[4],args[5],pins);
            if(args[1]=="migrate")DeleteVerifiedManual(root,ManualBytes,ManualSha256);
            else {
              AssertManualAbsent(root);
              guard.Revalidate(Path.Combine(root,GuardName));guard.Delete();
            }
          }
          if(args[1]=="complete")AssertAbsent(Path.Combine(root,GuardName));
        }
        return 0;
      } catch(Failure error) {return error.Code;}
      catch(InvalidDataException) {return 22;}
      catch(Win32Exception) {return 23;}
      catch(IOException) {return 23;}
      catch(UnauthorizedAccessException) {return 23;}
      catch {return 10;}
    }

    static Dictionary<string,string> ReadGuard(LockedFile file,string root) {
      if(file.Stream.Length>4096)throw new Failure(24,"Guard is oversized");
      file.Stream.Position=0;string text;
      using(var reader=new StreamReader(file.Stream,new UTF8Encoding(false,true),true,4096,true))text=reader.ReadToEnd();
      var values=new Dictionary<string,string>(StringComparer.Ordinal);
      string[] lines=text.Split(new[]{"\r\n","\n"},StringSplitOptions.RemoveEmptyEntries);
      if(lines.Length<3||lines[0]!="[ArkdownUpdate]")throw new Failure(24,"Unknown guard");
      foreach(string line in lines.Skip(1)) {
        int at=line.IndexOf('=');if(at<1||values.ContainsKey(line.Substring(0,at)))throw new Failure(24,"Unknown guard");
        values.Add(line.Substring(0,at),line.Substring(at+1));
      }
      string schema,target;
      if(!values.TryGetValue("Schema",out schema)||schema!="1"||!values.TryGetValue("Target",out target)
        ||!String.Equals(target,root,StringComparison.OrdinalIgnoreCase))throw new Failure(24,"Guard target mismatch");
      string session,marker,instance;
      if(values.Count==3&&values.TryGetValue("Session",out session)) {
        if(!String.Equals(Path.GetDirectoryName(Safety.Full(session)),Path.GetDirectoryName(root),StringComparison.OrdinalIgnoreCase)
          ||!Regex.IsMatch(Path.GetFileName(session),"^\\.ArkdownUpdate-[a-f0-9]{32}$"))throw new Failure(24,"Unknown update session");
      } else if(values.Count!=4||!values.TryGetValue("InstallerFinalize",out marker)||marker!="1"
        ||!values.TryGetValue("Instance",out instance)||!Regex.IsMatch(instance,"^[a-f0-9]{32}$"))throw new Failure(24,"Unknown guard");
      file.Stream.Position=0;return values;
    }
    static bool Prepare(string root) {
      string target=Path.Combine(root,GuardName);
      try {using(var existing=new LockedFile(target,false,false)){ReadGuard(existing,root);return false;}}
      catch(Win32Exception error) {if(!Missing(error))throw;}
      byte[] content=Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("[ArkdownUpdate]\r\nSchema=1\r\nTarget="+root+"\r\nInstallerFinalize=1\r\nInstance="+Guid.NewGuid().ToString("N")+"\r\n")).ToArray();
      // Publish a complete guard with a held-handle, no-overwrite rename. A failed
      // write must never strand a truncated final guard and prevent a retry.
      string temporary=target+"."+Guid.NewGuid().ToString("N")+".tmp";
      using(var created=new LockedFile(temporary,true,true)) {
        try {
          created.Stream.Write(content,0,content.Length);created.Stream.Flush(true);
          created.Revalidate(temporary);created.Rename(target);
        } catch {
          // Only this exclusively-created temporary object is ours to remove.
          try {created.Revalidate(temporary);created.Delete();} catch {}
          throw;
        }
      }
      return true;
    }
    static void VerifyInstalled(string root,string expectedHash,string version,string edition,DirectoryPins pins) {
      pins.Pin(Path.Combine(root,"resources"),false);
      using(var held=new LockedFile(Path.Combine(root,Manifest.Relative),false,false)) {
        if(held.Stream.Length>32*1024*1024||Safety.Hash(held.Stream)!=expectedHash)throw new Failure(20,"Installed manifest mismatch");
        Manifest manifest;
        using(var reader=new StreamReader(held.Stream,new UTF8Encoding(false,true),true,4096,true))manifest=Manifest.Validate(Safety.Json.Deserialize<Manifest>(reader.ReadToEnd()),version,edition);
        var files=manifest.files.ToDictionary(f=>f.path,StringComparer.Ordinal);
        var required=new List<string>{"Arkdown.exe","resources/app.asar","resources/package-edition.json"};
        if(edition=="Full") {
          const string tree="resources/components/pandoc/component-manifest.json";
          ManagedFile inventory;
          if(!files.TryGetValue(tree,out inventory)||inventory.sha256!=PandocManifestSha256)throw new Failure(20,"Pandoc r2 manifest missing");
          required.AddRange(new[]{tree,"resources/components/pandoc/pandoc.exe","resources/components/pandoc/COPYING.rtf","resources/components/pandoc/COPYRIGHT.txt","resources/components/pandoc/licenses/THIRD_PARTY_LICENSES.txt"});
        }
        foreach(string relative in required) {
          ManagedFile expected;if(!files.TryGetValue(relative,out expected))throw new Failure(20,"Required installed file missing");
          string target=Safety.Under(root,relative);pins.Pin(Path.GetDirectoryName(target),false);
          using(var file=new LockedFile(target,false,false)) {try {Safety.Verify(file,expected);}catch(InvalidDataException){throw new Failure(20,"Installed file mismatch");}}
        }
      }
    }

    // Internal primitive shared with native safety tests. Production CLI always
    // passes the constants above; no path or legacy digest is accepted via argv.
    internal static void DeleteVerifiedManual(string root,long expectedBytes,string expectedSha256) {
      if(expectedBytes<0||!Hash(expectedSha256))throw new InvalidDataException("Invalid expected file identity");
      string target=Safety.Under(root,ManualRelative);
      using(var pins=new DirectoryPins()) {
        try {pins.Pin(Path.GetDirectoryName(target),false);}
        catch(Win32Exception error) {if(Missing(error))return;throw;}
        try {
          using(var file=new LockedFile(target,true,false)) {
            if(file.Stream.Length!=expectedBytes||Safety.Hash(file.Stream)!=expectedSha256)throw new Failure(21,"Unknown legacy file retained");
            file.Revalidate(target);file.Delete();
          }
        } catch(Win32Exception error) {if(Missing(error))return;throw;}
        AssertAbsent(target);
      }
    }
    static void AssertManualAbsent(string root) {
      using(var pins=new DirectoryPins()) {
        try {pins.Pin(Path.GetDirectoryName(Safety.Under(root,ManualRelative)),false);}
        catch(Win32Exception error) {if(Missing(error))return;throw;}
        AssertAbsent(Safety.Under(root,ManualRelative));
      }
    }
    static void AssertAbsent(string target) {
      try {using(var file=new LockedFile(target,false,false)){}throw new Failure(21,"Legacy file or guard remains");}
      catch(Win32Exception error) {if(!Missing(error))throw;}
    }
  }
}
