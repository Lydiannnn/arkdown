using System;
using System.IO;
namespace Arkdown.Update {
  static class RestartSafety {
    public static bool CanRestoreOriginal(string target,string version,string edition,bool installerStarted) {
      if(installerStarted||Safety.FileExists(Path.Combine(target,PortableTransaction.PendingName)))return false;
      try {
        using(var pins=new DirectoryPins()) {
          pins.Pin(target,false);var manifest=Manifest.Read(target,version,edition);
          foreach(var item in manifest.files) { pins.Pin(Path.GetDirectoryName(Safety.Under(target,item.path)),false);using(var file=new LockedFile(Safety.Under(target,item.path),false,false))Safety.Verify(file,item); }
        }
        return true;
      }catch{return false;}
    }
  }
}
