using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Arkdown.Update {
  sealed class ManagedFile { public string path {get;set;} public long bytes {get;set;} public string sha256 {get;set;} }
  sealed class Manifest {
    public const string Relative="resources/update-managed-files.json";
    public int schemaVersion {get;set;} public string product {get;set;} public string version {get;set;} public string edition {get;set;} public List<ManagedFile> files {get;set;}
    public static Manifest Read(string root,string version,string edition) {
      var m=Safety.ReadJson<Manifest>(Path.Combine(root,Relative),32*1024*1024);
      return Validate(m,version,edition);
    }
    public static Manifest Validate(Manifest m,string version,string edition) {
      if(m==null||m.schemaVersion!=1||m.product!="Arkdown"||m.version!=version||m.edition!=edition||m.files==null||m.files.Count<2||m.files.Count>100000)throw new InvalidDataException("Package identity mismatch");
      Safety.Version(m.version);if(m.edition!="Full"&&m.edition!="Lite")throw new InvalidDataException("Invalid edition");
      var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
      foreach(var f in m.files) {
        if(f==null||!names.Add(Safety.Relative(f.path))||String.Equals(f.path,Relative,StringComparison.OrdinalIgnoreCase)||f.bytes<0||f.bytes>Safety.MaxBytes||f.sha256==null||!Regex.IsMatch(f.sha256,"^[a-f0-9]{64}$"))throw new InvalidDataException("Invalid managed entry");
        total=checked(total+f.bytes);if(total>Safety.MaxBytes)throw new InvalidDataException("Package too large");
      }
      if(!names.Contains("Arkdown.exe")||!names.Contains("resources/app.asar"))throw new InvalidDataException("Incomplete program manifest");return m;
    }
    public List<ManagedFile> WithSelf(string root) {
      var result=new List<ManagedFile>(files);string file=Path.Combine(root,Relative);
      result.Add(new ManagedFile { path=Relative,bytes=new FileInfo(Safety.IoPath(file)).Length,sha256=Safety.HashFile(file) });return result;
    }
  }
  sealed class VerifiedPackage {
    readonly ManagedFile[] files;
    static ManagedFile Copy(ManagedFile f) { return new ManagedFile {path=f.path,bytes=f.bytes,sha256=f.sha256}; }
    public VerifiedPackage(IEnumerable<ManagedFile> files) { this.files=files.Select(Copy).ToArray(); }
    public Dictionary<string,ManagedFile> Snapshot() { return files.Select(Copy).ToDictionary(f=>f.path,StringComparer.OrdinalIgnoreCase); }
  }
  static class PackageStage {
    public static VerifiedPackage Extract(string package,string stage,string version,string edition) {
      try {
      using(var pins=new DirectoryPins())using(var held=new LockedFile(package,false,false)) {
        try {
        try {pins.Pin(stage,true);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.pin",null,stage);throw;}
        using(var zip=new ZipArchive(held.Stream,ZipArchiveMode.Read,true)) {
          try {
          if(zip.Entries.Count<3||zip.Entries.Count>120000)throw new InvalidDataException("Invalid ZIP size");
          long expanded=0;foreach(var entry in zip.Entries) { expanded=checked(expanded+entry.Length);if(expanded>Safety.MaxBytes)throw new InvalidDataException("ZIP expanded size limit"); }
          if(new DriveInfo(Path.GetPathRoot(stage)).AvailableFreeSpace<expanded+64*1024*1024)throw new IOException("更新所需的可用磁盘空间不足，请释放空间后重试。");
          var manifestEntries=zip.Entries.Where(e=>e.FullName==Manifest.Relative||e.FullName.EndsWith("/"+Manifest.Relative,StringComparison.Ordinal)).ToList();
          if(manifestEntries.Count!=1)throw new InvalidDataException("Package manifest missing or ambiguous");
          // Establish trust from the locked ZIP itself, never from the writable
          // extraction directory. Retain the exact manifest bytes' hash too.
          var manifestEntry=manifestEntries[0];
          byte[] manifestBytes;Manifest manifest;
          try {
          if(manifestEntry.Length<=0||manifestEntry.Length>32*1024*1024)throw new InvalidDataException("Invalid manifest size");
          manifestBytes=new byte[checked((int)manifestEntry.Length)];
          using(var input=manifestEntry.Open()) {
            try {
              int offset=0,n;while(offset<manifestBytes.Length&&(n=input.Read(manifestBytes,offset,manifestBytes.Length-offset))>0)offset+=n;
              if(offset!=manifestBytes.Length||input.ReadByte()!=-1)throw new InvalidDataException("Invalid manifest length");
            }catch(Exception error) {FailureDiagnostics.RememberRelative(error,"stage.manifest",null,stage,Manifest.Relative);throw;}
          }
          using(var bytes=new MemoryStream(manifestBytes))using(var reader=new StreamReader(bytes,new System.Text.UTF8Encoding(false,true),true))
            manifest=Manifest.Validate(Safety.Json.Deserialize<Manifest>(reader.ReadToEnd()),version,edition);
          }catch(Exception error) {FailureDiagnostics.RememberRelative(error,"stage.manifest",null,stage,Manifest.Relative);throw;}
          var trustedFiles=new List<ManagedFile>(manifest.files);
          using(var bytes=new MemoryStream(manifestBytes))trustedFiles.Add(new ManagedFile {path=Manifest.Relative,bytes=manifestBytes.Length,sha256=Safety.Hash(bytes)});
          var verified=new VerifiedPackage(trustedFiles);
          string prefix=manifestEntries[0].FullName.Substring(0,manifestEntries[0].FullName.Length-Manifest.Relative.Length);
          if(prefix.Length>0&&(prefix.TrimEnd('/').Contains("/")||Safety.Relative(prefix.TrimEnd('/')).Length==0))throw new InvalidDataException("Invalid ZIP root");
          var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
          foreach(var e in zip.Entries) {
            bool directory=e.FullName.EndsWith("/");string full=e.FullName.TrimEnd('/');Safety.Relative(full);
            if(directory&&full==prefix.TrimEnd('/'))continue;
            if(!e.FullName.StartsWith(prefix,StringComparison.Ordinal))throw new InvalidDataException("ZIP entry outside package");
            string rel=e.FullName.Substring(prefix.Length).TrimEnd('/');Safety.Relative(rel);
            uint attributes=unchecked((uint)e.ExternalAttributes);uint type=(attributes>>16)&0xf000;
            if((attributes&0x400)!=0||(type!=0&&type!=0x8000&&type!=0x4000)||!names.Add(rel))throw new InvalidDataException("Unsafe or duplicate ZIP entry");
            string output=Safety.Under(stage,rel);
            if(directory) { try {pins.Pin(output,true);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.entry",null,output);throw;}continue; }
            total=checked(total+e.Length);if(e.Length<0||total>Safety.MaxBytes)throw new InvalidDataException("ZIP expanded size limit");
            try {pins.Pin(Path.GetDirectoryName(output),true);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.entry",null,output);throw;}
            // Preserve the first failure before each existing using unwinds;
            // an exception thrown by Dispose remains the terminal exception.
            try {
            using(var dest=new LockedFile(output,true,true)) {
              try {
              using(var source=e.Open()) {
              try {
              byte[] buffer=new byte[128*1024];long read=0;int n;
              while(true) {
                try {n=source.Read(buffer,0,buffer.Length);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.read","Stream.Read",output);throw;}
                if(n<=0)break;read+=n;if(read>e.Length)throw new InvalidDataException("ZIP length mismatch");
                try {dest.Stream.Write(buffer,0,n);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.write","FileStream.Write",output);throw;}
              }
              if(read!=e.Length)throw new InvalidDataException("Truncated ZIP entry");
              try {dest.Stream.Flush(true);}catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.flush","FileStream.Flush",output);throw;}
              }catch(Exception error) {FailureDiagnostics.Remember(error,"stage.extract.entry",null,output);throw;}
              }
              }catch(Exception error) {FailureDiagnostics.Remember(error,FailureDiagnostics.IsDispose(error)?"stage.extract.entry.dispose":"stage.extract.entry",null,output);throw;}
            }
            }catch(Exception error) {FailureDiagnostics.Remember(error,FailureDiagnostics.IsDispose(error)?"stage.extract.entry.dispose":"stage.extract.entry",null,output);throw;}
          }
          var allowed=new HashSet<string>(trustedFiles.Select(f=>f.path),StringComparer.OrdinalIgnoreCase);
          string ioStage=Safety.IoPath(stage);
          try {
            foreach(string file in Directory.GetFiles(ioStage,"*",SearchOption.AllDirectories))if(!allowed.Contains(file.Substring(ioStage.Length+1).Replace('\\','/')))throw new InvalidDataException("Unmanaged file in update package");
          }catch(Exception error) {FailureDiagnostics.Remember(error,"stage.enumerate","Directory.GetFiles",stage);throw;}
          foreach(var f in trustedFiles) {
            try {
              using(var file=new LockedFile(Safety.Under(stage,f.path),false,false)) {
                try {Safety.Verify(file,f);}catch(Exception error) {FailureDiagnostics.RememberRelative(error,"stage.verify.content","Safety.Verify",stage,f.path);throw;}
              }
            }catch(Exception error) {FailureDiagnostics.RememberRelative(error,FailureDiagnostics.IsDispose(error)?"stage.verify.dispose":"stage.verify.open",null,stage,f.path);throw;}
          }
          return verified;
          }catch(Exception error) {FailureDiagnostics.Remember(error,"zip.open",null,package);throw;}
        }
        }catch(Exception error) {FailureDiagnostics.Remember(error,FailureDiagnostics.IsDispose(error)?"stage.finalize":"zip.open",null,package);throw;}
      }
      // Consume on failure only, including when outer Dispose replaced a throw.
      }catch(Exception error) {FailureDiagnostics.Consume(error,FailureDiagnostics.IsDispose(error)?"stage.finalize":"stage.open",null,package);throw;}
    }
  }
  sealed class JournalEntry { public string path {get;set;} public ManagedFile oldFile {get;set;} public ManagedFile newFile {get;set;} public int index {get;set;} }
  sealed class UpdateJournal { public int schemaVersion {get;set;} public string target {get;set;} public string oldVersion {get;set;} public string newVersion {get;set;} public string edition {get;set;} public string state {get;set;} public List<JournalEntry> entries {get;set;} }
  sealed class PendingUpdate { public int schemaVersion {get;set;} public string session {get;set;} }
  sealed class PortableTransaction {
    public const string PendingName=".arkdown-update-pending.json";
    readonly string root,stage,session,oldVersion,newVersion,edition;
    readonly VerifiedPackage verifiedPackage;
    public PortableTransaction(string root,string stage,string session,string oldVersion,string newVersion,string edition,VerifiedPackage verifiedPackage) {
      if(verifiedPackage==null)throw new InvalidDataException("Verified package inventory required");this.verifiedPackage=verifiedPackage;
      this.root=Safety.Full(root);this.stage=Safety.Full(stage);this.session=Safety.Full(session);this.oldVersion=oldVersion;this.newVersion=newVersion;this.edition=edition;
      if(this.stage.StartsWith(this.root+"\\",StringComparison.OrdinalIgnoreCase)||this.session.StartsWith(this.root+"\\",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Update staging must be outside application");
    }
    public void Apply(Action<int> afterOperation) {
      using(var pins=new DirectoryPins()) {
        pins.Pin(root,false);pins.Pin(stage,false);pins.Pin(session,true);pins.Pin(Path.Combine(session,"backup"),true);pins.Pin(Path.Combine(session,"replaced"),true);
        if(Safety.FileExists(Path.Combine(root,PendingName)))throw new InvalidDataException("Previous update needs recovery");
        var old=Manifest.Read(root,oldVersion,edition).WithSelf(root).ToDictionary(f=>f.path,StringComparer.OrdinalIgnoreCase);
        var next=verifiedPackage.Snapshot();
        var entries=old.Keys.Union(next.Keys,StringComparer.OrdinalIgnoreCase).OrderBy(p=>p=="Arkdown.exe"?2:p==Manifest.Relative?1:0).ThenBy(p=>p,StringComparer.Ordinal).Select((p,i)=>new JournalEntry { path=p,index=i,oldFile=old.ContainsKey(p)?old[p]:null,newFile=next.ContainsKey(p)?next[p]:null }).ToList();
        var heldOld=new Dictionary<string,LockedFile>(StringComparer.OrdinalIgnoreCase);var heldNew=new Dictionary<string,LockedFile>(StringComparer.OrdinalIgnoreCase);var moved=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var installed=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool journalWritten=false;
        try {
          foreach(var e in entries) {
            pins.Pin(Path.GetDirectoryName(Safety.Under(root,e.path)),true);
            if(e.oldFile!=null) { var f=new LockedFile(Safety.Under(root,e.path),true,false);heldOld.Add(e.path,f);Safety.Verify(f,e.oldFile); }
            else if(Safety.FileExists(Safety.Under(root,e.path))||Safety.DirectoryExists(Safety.Under(root,e.path)))throw new InvalidDataException("Unknown file collides with update: "+e.path);
            if(e.newFile!=null) { pins.Pin(Path.GetDirectoryName(Safety.Under(stage,e.path)),false);var f=new LockedFile(Safety.Under(stage,e.path),true,false);heldNew.Add(e.path,f);Safety.Verify(f,e.newFile); }
          }
          var journal=new UpdateJournal { schemaVersion=1,target=root,oldVersion=oldVersion,newVersion=newVersion,edition=edition,state="replacing",entries=entries };
          Safety.WriteJson(Path.Combine(session,"journal.json"),journal);
          Safety.WriteJson(Path.Combine(root,PendingName),new PendingUpdate { schemaVersion=1,session=Path.GetFileName(session) });journalWritten=true;
          int completed=0;
          foreach(var e in entries) {
            if(e.oldFile!=null) { heldOld[e.path].Rename(Path.Combine(session,"backup",e.index.ToString()));moved.Add(e.path); }
            if(e.newFile!=null) { heldNew[e.path].Rename(Safety.Under(root,e.path));installed.Add(e.path); }
            if(afterOperation!=null)afterOperation(++completed);
          }
          journal.state="applied";Safety.WriteJson(Path.Combine(session,"journal.json"),journal);
          // Keep the marker until a fresh application process confirms its version.
        } catch {
          bool recovered=true;Exception rollbackError=null;
          foreach(var e in entries.AsEnumerable().Reverse())try {
            if(installed.Contains(e.path))heldNew[e.path].Rename(Path.Combine(session,"replaced",e.index.ToString()));
            if(moved.Contains(e.path))heldOld[e.path].Rename(Safety.Under(root,e.path));
          } catch(Exception error) { recovered=false;rollbackError=error; }
          if(journalWritten&&recovered)FinishMarker(root,session,"rolled-back");
          if(!recovered)throw new IOException("更新未完成，自动恢复也受到文件锁定或外部修改阻止。请保留更新目录，通过原安装包修复；用户文档未被删除。",rollbackError);
          throw;
        } finally { foreach(var f in heldNew.Values)f.Dispose();foreach(var f in heldOld.Values)f.Dispose(); }
      }
    }
    public static void FinishMarker(string root,string session,string state) {
      var journal=Safety.ReadJson<UpdateJournal>(Path.Combine(session,"journal.json"),32*1024*1024);journal.state=state;Safety.WriteJson(Path.Combine(session,"journal.json"),journal);
      string marker=Path.Combine(root,PendingName);if(Safety.FileExists(marker))using(var file=new LockedFile(marker,true,false))file.Rename(Path.Combine(session,"marker-"+Guid.NewGuid().ToString("N")+".json"));
    }
    public static void Recover(string root,string session) {
      root=Safety.Full(root);session=Safety.Full(session);var j=Safety.ReadJson<UpdateJournal>(Path.Combine(session,"journal.json"),32*1024*1024);
      if(j==null||j.schemaVersion!=1||!String.Equals(j.target,root,StringComparison.OrdinalIgnoreCase)||j.entries==null||j.entries.Count>100001)throw new InvalidDataException("Invalid recovery journal");
      if(j.state=="complete"||j.state=="rolled-back") {
        var actual=Manifest.Read(root,RecoveryEntry.ExpectedVersion(j),j.edition);
        foreach(var file in actual.files)using(var held=new LockedFile(Safety.Under(root,file.path),false,false))Safety.Verify(held,file);
        FinishMarker(root,session,j.state);return;
      }
      var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var indices=new HashSet<int>();
      using(var pins=new DirectoryPins()) {
        pins.Pin(root,false);pins.Pin(session,false);pins.Pin(Path.Combine(session,"backup"),false);pins.Pin(Path.Combine(session,"replaced"),true);
        foreach(var e in j.entries) {
          if(e==null||!names.Add(Safety.Relative(e.path))||e.index<0||!indices.Add(e.index))throw new InvalidDataException("Invalid recovery path");
          if((e.oldFile!=null&&e.oldFile.path!=e.path)||(e.newFile!=null&&e.newFile.path!=e.path))throw new InvalidDataException("Invalid recovery identity");
        }
        foreach(var e in j.entries.AsEnumerable().Reverse()) {
          string target=Safety.Under(root,e.path),backup=Path.Combine(session,"backup",e.index.ToString());pins.Pin(Path.GetDirectoryName(target),false);
          if(Safety.FileExists(backup)) {
            if(e.oldFile==null)throw new InvalidDataException("Unexpected recovery backup");
            using(var old=new LockedFile(backup,true,false)) { Safety.Verify(old,e.oldFile);
              if(Safety.FileExists(target)) { if(e.newFile==null)throw new InvalidDataException("Recovery target modified");using(var current=new LockedFile(target,true,false)) { Safety.Verify(current,e.newFile);current.Rename(Path.Combine(session,"replaced",Guid.NewGuid().ToString("N"))); } }
              old.Rename(target);
            }
          } else if(e.oldFile==null) {
            if(Safety.FileExists(target))using(var added=new LockedFile(target,true,false)) { Safety.Verify(added,e.newFile);added.Rename(Path.Combine(session,"replaced",Guid.NewGuid().ToString("N"))); }
          } else using(var current=new LockedFile(target,false,false))Safety.Verify(current,e.oldFile);
        }
        FinishMarker(root,session,"rolled-back");
      }
    }
  }
}
