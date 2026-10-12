using System;
using System.IO;
using System.Text.RegularExpressions;

namespace Arkdown.Update {
  // Double-clicking the already-copied helper remains available even when the
  // interrupted transaction temporarily left Arkdown.exe or app.asar absent.
  static class RecoveryEntry {
    public static string ExpectedVersion(UpdateJournal journal) {
      if(journal==null)throw new InvalidDataException("Missing recovery journal");
      if(journal.state=="complete")return journal.newVersion;
      if(journal.state=="rolled-back"||journal.state=="replacing"||journal.state=="applied")return journal.oldVersion;
      throw new InvalidDataException("Unknown recovery state");
    }
    public static HandoffRequest Read(string executable) {
      string session=Safety.Full(Path.GetDirectoryName(executable));
      if(!Regex.IsMatch(Path.GetFileName(session),@"^\.ArkdownUpdate-[a-f0-9]{32}$"))throw new InvalidDataException("Invalid standalone recovery location");
      using(var pins=new DirectoryPins()) {
        pins.Pin(session,false);
        var request=Safety.ReadJson<HandoffRequest>(Path.Combine(session,"request.json"),16384);
        if(request==null||request.kind!="portable"||request.session!=session||String.IsNullOrEmpty(request.target))throw new InvalidDataException("Invalid recovery request");
        string target=Safety.Full(request.target);
        if(!String.Equals(Path.GetDirectoryName(target),Path.GetDirectoryName(session),StringComparison.OrdinalIgnoreCase)||target==session)throw new InvalidDataException("Invalid recovery target");
        pins.Pin(target,false);
        var marker=Safety.ReadJson<PendingUpdate>(Path.Combine(target,PortableTransaction.PendingName),1024);
        var journal=Safety.ReadJson<UpdateJournal>(Path.Combine(session,"journal.json"),32*1024*1024);
        if(marker==null||marker.schemaVersion!=1||marker.session!=Path.GetFileName(session)||journal==null||journal.schemaVersion!=1||journal.target!=target||journal.edition!=request.edition)throw new InvalidDataException("Invalid standalone recovery identity");
        string expected=ExpectedVersion(journal);
        if(request.recover ? expected!=request.version||(request.oldVersion!=journal.oldVersion&&request.oldVersion!=journal.newVersion) : journal.oldVersion!=request.oldVersion||journal.newVersion!=request.version)throw new InvalidDataException("Invalid recovery versions");
        request.oldVersion=journal.newVersion;request.version=expected;request.recover=true;
        request.token=Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N");
        return request;
      }
    }
  }
}
