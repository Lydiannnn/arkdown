; YPF. Copyright (c) 2026 Miterh.
; Both editions and all later releases MUST keep this identity and install mode.
#define StableAppId "ArkVibe.Arkdown"
#ifndef InstallerFinalizeHelper
  #error InstallerFinalizeHelper must come from the audited application payload
#endif
#ifndef InstallerFinalizeHelperSha256
  #error InstallerFinalizeHelperSha256 is required
#endif
#ifndef InstalledManifestSha256
  #error InstalledManifestSha256 is required
#endif

[Setup]
AppId={#StableAppId}
AppName=Arkdown
AppVersion={#AppVersion}
AppVerName=Arkdown {#AppVersion} {#Edition}
AppPublisher=Miterh
AppPublisherURL=https://github.com/Lydiannnn/arkdown-releases
AppSupportURL=https://github.com/Lydiannnn/arkdown-releases/issues
AppUpdatesURL=https://github.com/Lydiannnn/arkdown-releases/releases/latest
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany=Miterh
VersionInfoDescription=Arkdown {#Edition} 安装程序
VersionInfoCopyright=Copyright (c) 2026 Miterh
DefaultDirName={localappdata}\Programs\Arkdown
AppendDefaultDirName=no
DefaultGroupName=Arkdown
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UsePreviousAppDir=yes
UsePreviousTasks=yes
DisableDirPage=auto
DisableProgramGroupPage=yes
DisableWelcomePage=no
AllowNoIcons=yes
UninstallDisplayName=Arkdown
UninstallDisplayIcon={app}\Arkdown.exe
UninstallFilesDir={app}\uninstall
UninstallLogMode=append
SetupIconFile={#RepoRoot}\assets\branding\arkdown-app-rounded.ico
WizardStyle=modern dynamic
WizardSizePercent=110
OutputDir={#OutputDir}
OutputBaseFilename=Arkdown-{#AppVersion}-{#Edition}-Windows-x64-Setup
Compression=lzma2/normal
SolidCompression=yes
LZMAUseSeparateProcess=yes
SetupMutex=Local\ArkVibe.Arkdown.Setup
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
ChangesAssociations=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Messages]
WelcomeLabel2=即将安装 Arkdown {#AppVersion} {#Edition}。%n%n覆盖升级会保留设置、便签、下载组件、文档和未保存草稿。%n%n如果此前使用解压版，请在下一步选择原 Arkdown.exe 所在的文件夹。安装前请退出 Arkdown 和托盘中的 Arknote。
SelectDirDesc=选择安装位置；升级解压版时，请选择原程序所在目录。
SelectDirLabel3=首次安装默认使用当前用户的程序目录。%n升级已有解压版时请选择原 Arkdown.exe 所在文件夹，以继续使用原有设置和便签。
FinishedLabel=Arkdown 安装完成。%n%n卸载仅移除程序，用户数据和初始工作区会保留。
ConfirmUninstall=是否卸载 Arkdown？%n%n程序将被移除，设置、便签、草稿及文档将保留。请先退出 Arkdown 和托盘中的 Arknote。

[Tasks]
Name: "desktopicon"; Description: "创建 Arkdown 桌面快捷方式"; GroupDescription: "快捷方式："
Name: "arknotedesktopicon"; Description: "创建 Arknote 桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
#include PayloadFileList
Source: "{#InstallerFinalizeHelper}"; DestDir: "{tmp}"; Flags: dontcopy

[INI]
; Every completed setup gets a new offer identity, even when reinstalling the same
; version. This small metadata file stays on uninstall; no new deletion rule is added.
Filename: "{app}\.arkdown-installation.ini"; Section: "ArkdownStartup"; Key: "Instance"; String: "{code:InstallationInstance}"

[Icons]
Name: "{group}\Arkdown"; Filename: "{app}\Arkdown.exe"; WorkingDir: "{app}"
Name: "{group}\Arknote"; Filename: "{app}\Arknote.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Arkdown"; Filename: "{app}\Arkdown.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{autodesktop}\Arknote"; Filename: "{app}\Arknote.exe"; WorkingDir: "{app}"; Tasks: arknotedesktopicon

[Run]
Filename: "{app}\Arkdown.exe"; Description: "启动 Arkdown"; WorkingDir: "{app}"; Flags: nowait postinstall unchecked; Check: CanLaunchFinalizedApplication

[Code]
#include AssociationCleanupIncludeFile

var
  FinalizationPrepared, FinalizationMigrated, FinalizationCompleted, FinalizationNoRestartObserved: Boolean;
  FinalizationOwnGuard, FinalizationCompletionAttempted: Boolean;
  FinalizationGuardSha256, FinalizationError: String;

function InstallationTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function InstallationInstance(Param: String): String;
begin
  Result := GetDateTimeString('yyyymmddhhnnss', '-', ':') + '-' + IntToStr(InstallationTickCount);
end;

function SetEnvironmentVariable(Name, Value: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure RemoveOwnedAssociations;
var
  Previous, PreviousTestMode, PreviousTestRoot, Parameters: String;
  ExitCode: Integer;
  Started: Boolean;
begin
  Previous := GetEnv('ARKDOWN_UNINSTALL_EXECUTABLE');
  PreviousTestMode := GetEnv('ARKDOWN_E2E');
  PreviousTestRoot := GetEnv('ARKDOWN_REGISTRY_TEST_ROOT');
  if not SetEnvironmentVariable('ARKDOWN_UNINSTALL_EXECUTABLE', ExpandConstant('{app}\Arkdown.exe')) then
    RaiseException('无法准备文件关联清理，程序尚未移除。');
  try
    { Production cleanup must not inherit a developer's registry test mode. }
#ifdef UninstallRegistryTestRoot
    if not SetEnvironmentVariable('ARKDOWN_E2E', '1') or
      not SetEnvironmentVariable('ARKDOWN_REGISTRY_TEST_ROOT', '{#UninstallRegistryTestRoot}') then Abort;
#else
    if not SetEnvironmentVariable('ARKDOWN_E2E', '') or
      not SetEnvironmentVariable('ARKDOWN_REGISTRY_TEST_ROOT', '') then Abort;
#endif
    Parameters := '-NoProfile -NonInteractive -EncodedCommand ' + AssociationCleanupEncoded;
    Started := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  finally
    SetEnvironmentVariable('ARKDOWN_UNINSTALL_EXECUTABLE', Previous);
    SetEnvironmentVariable('ARKDOWN_E2E', PreviousTestMode);
    SetEnvironmentVariable('ARKDOWN_REGISTRY_TEST_ROOT', PreviousTestRoot);
  end;
  Log(Format('Arkdown association cleanup: started=%d, exit=%d', [Ord(Started), ExitCode]));
  if not Started or (ExitCode <> 0) then begin
    SuppressibleMsgBox('未能清理 Arkdown 的文件关联，程序尚未移除。请在 Windows 默认应用设置中为相关文件选择其他程序后，再次卸载。', mbError, MB_OK, IDOK);
    Abort;
  end;
end;

function SamePath(First, Second: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(ExpandFileName(First)), RemoveBackslashUnlessRoot(ExpandFileName(Second))) = 0;
end;

function SafetyWin32Path(FileName: String): String;
begin
  { Inno handles long paths internally; direct Win32 calls need extended paths.
    Expand ordinary paths before prefixing, since extended paths do not resolve
    dot segments. Keep display/comparison and ancestor traversal paths unchanged. }
  if Copy(FileName, 1, 4) = '\\?\' then begin
    Result := FileName;
    Exit;
  end;
  Result := ExpandFileName(FileName);
  if Copy(Result, 1, 2) = '\\' then
    Result := '\\?\UNC\' + Copy(Result, 3, Length(Result) - 2)
  else
    Result := '\\?\' + Result;
end;

function SafetyAttributesNative(FileName: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function SafetyAttributes(FileName: String): Cardinal;
begin
  Result := SafetyAttributesNative(SafetyWin32Path(FileName));
end;

type
  TSafetyFindData = record
    Attributes: Cardinal;
    CreationTime, LastAccessTime, LastWriteTime: TFileTime;
    SizeHigh, SizeLow, Reserved0, Reserved1: Cardinal;
    Name: array[0..259] of Word;
    AlternateName: array[0..13] of Word;
  end;

function SafetyFindFirst(Pattern: String; var Data: TSafetyFindData): THandle;
  external 'FindFirstFileW@kernel32.dll stdcall';
function SafetyFindNext(Handle: THandle; var Data: TSafetyFindData): Boolean;
  external 'FindNextFileW@kernel32.dll stdcall';
function SafetyFindClose(Handle: THandle): Boolean;
  external 'FindClose@kernel32.dll stdcall';

procedure AssertPlainAncestors(FileName: String);
var
  Current, Parent: String;
  Attributes: Cardinal;
  ErrorCode: Integer;
begin
  Current := RemoveBackslashUnlessRoot(ExpandFileName(FileName));
  repeat
    Attributes := SafetyAttributes(Current);
    if Attributes = $FFFFFFFF then begin
      ErrorCode := DLLGetLastError;
      if (ErrorCode <> 2) and (ErrorCode <> 3) then RaiseException('无法检查路径，已停止操作：' + Current);
    end else if (Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
      RaiseException('安装路径含有目录链接或重解析点，已停止操作以保护外部文件：' + Current);
    Parent := RemoveBackslashUnlessRoot(ExtractFileDir(Current));
    if CompareText(Current, Parent) = 0 then Exit;
    Current := Parent;
  until Current = '';
end;

procedure AssertPlainTree(Directory: String);
var
  Found: TSafetyFindData;
  Handle: THandle;
  Child, EntryName: String;
  I, ErrorCode: Integer;
begin
  Handle := SafetyFindFirst(SafetyWin32Path(AddBackslash(Directory) + '*'), Found);
  if Handle = THandle(-1) then begin
    ErrorCode := DLLGetLastError;
    if ErrorCode = 2 then Exit; { An empty directory is safe. }
    RaiseException('无法完整检查安装目录，已停止操作：' + Directory);
  end;
  try
    repeat
      EntryName := '';
      I := 0;
      while (I < 260) and (Found.Name[I] <> 0) do begin
        EntryName := EntryName + Chr(Found.Name[I]);
        I := I + 1;
      end;
      if (EntryName <> '.') and (EntryName <> '..') then begin
        Child := AddBackslash(Directory) + EntryName;
        { These roots were never included in any supported uninstall log. }
        if not (SamePath(Directory, ExpandConstant('{app}')) and
          ((CompareText(EntryName, 'portable-data') = 0) or (CompareText(EntryName, 'temp') = 0) or
           (IsUninstaller and (CompareText(EntryName, '初始工作区') = 0)))) then begin
          if (Found.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
            RaiseException('安装目录含有链接，已停止操作以保护链接目标：' + Child);
          if (Found.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then AssertPlainTree(Child);
        end;
      end;
    until not SafetyFindNext(Handle, Found);
    ErrorCode := DLLGetLastError;
    if ErrorCode <> 18 then RaiseException('安装目录检查中断，已停止操作：' + Directory);
  finally
    SafetyFindClose(Handle);
  end;
end;

procedure AssertOwnedShortcut(BaseName, ExpectedTarget: String);
var
  Shell, Link: Variant;
  Target, ShortcutPath: String;
begin
  if FileExists(BaseName + '.pif') or (not IsUninstaller and FileExists(BaseName + '.url')) then
    RaiseException('存在无法确认归属的快捷方式，已停止操作。请先将此快捷方式改名保留：' + BaseName);
  ShortcutPath := BaseName + '.lnk';
  if not FileExists(ShortcutPath) then Exit;
  if (SafetyAttributes(ShortcutPath) and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
    RaiseException('快捷方式是文件链接，已停止操作：' + ShortcutPath);
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(ShortcutPath);
    Target := Link.TargetPath;
  except
    RaiseException('无法读取快捷方式，已停止操作：' + ShortcutPath);
  end;
  if (Target = '') or not SamePath(Target, ExpectedTarget) then
    RaiseException('快捷方式已指向其他位置，已停止操作。请先将此快捷方式改名保留：' + ShortcutPath);
end;

function CheckFileSafety: String;
begin
  Result := '';
  try
    AssertPlainAncestors(ExpandConstant('{app}'));
    if DirExists(ExpandConstant('{app}')) then AssertPlainTree(ExpandConstant('{app}'));
    AssertOwnedShortcut(ExpandConstant('{group}\Arkdown'), ExpandConstant('{app}\Arkdown.exe'));
    AssertOwnedShortcut(ExpandConstant('{group}\Arknote'), ExpandConstant('{app}\Arknote.exe'));
    AssertOwnedShortcut(ExpandConstant('{autodesktop}\Arkdown'), ExpandConstant('{app}\Arkdown.exe'));
    AssertOwnedShortcut(ExpandConstant('{autodesktop}\Arknote'), ExpandConstant('{app}\Arknote.exe'));
  except
    Result := GetExceptionMessage;
  end;
end;

function CheckRunning: String;
var
  Locator, Services, Processes, Item: Variant;
  I, ProcessCount: Integer;
  ImagePath, TargetPrefix, ImageName: String;
  IgnoredInstallerProcess: Boolean;
begin
  Result := '';
  TargetPrefix := AddBackslash(ExpandFileName(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT Name, ExecutablePath FROM Win32_Process');
    { Pascal Script reevaluates the loop bound; WMI Count enumerates the collection. }
    ProcessCount := Processes.Count;
    for I := 0 to ProcessCount - 1 do begin
      Item := Processes.ItemIndex(I);
      ImageName := Item.Name;
      if not VarIsNull(Item.ExecutablePath) then begin
        ImagePath := Item.ExecutablePath;
        IgnoredInstallerProcess := CompareText(Copy(ImagePath, 1, Length(TargetPrefix) + 10), TargetPrefix + 'uninstall\') = 0;
        if not IsUninstaller then
          if SamePath(ImagePath, ExpandConstant('{srcexe}')) then IgnoredInstallerProcess := True;
        if (CompareText(Copy(ImagePath, 1, Length(TargetPrefix)), TargetPrefix) = 0)
          and not IgnoredInstallerProcess then begin
          Result := '请先保存文档，并退出 Arkdown、托盘中的 Arknote 及翻译窗口后重试。仍在运行：' + ImageName;
          Exit;
        end;
      end else if (CompareText(ImageName, 'Arkdown.exe') = 0) or (CompareText(ImageName, 'Arknote.exe') = 0) then begin
        Result := '无法确认正在运行的 Arkdown / Arknote 所在目录。请先退出它们后重试。';
        Exit;
      end;
    end;
  except
    Result := '无法检查程序运行状态。请退出 Arkdown 和 Arknote 后重新启动安装程序。';
    Log(GetExceptionMessage);
  end;
end;

function FinalizationFailure(ExitCode: Integer): String;
begin
  case ExitCode of
    20: Result := '新版程序文件尚未完整写入或校验未通过。';
    21: Result := '旧版 Pandoc 说明文件内容无法确认，或文件尚未移除，已保留原文件。';
    22: Result := '安装路径、旧版说明文件或更新保护记录含有不安全链接，已停止清理。';
    23: Result := '旧版说明文件或更新保护记录无法读取或移除，可能被占用或受到访问限制。';
    24: Result := '更新保护记录已改变或无法确认，已保留现有文件。';
  else
    Result := '安装收尾助手未能完成校验。';
  end;
  Result := Result + #13#10 + '请保留程序和用户数据，关闭相关程序后重新运行官方完整安装包修复。' + #13#10 +
    ExpandConstant('{app}\resources\components\pandoc\MANUAL.html');
end;

type
  TFinalizationHandleInfo = record
    Attributes: Cardinal;
    CreationTime, LastAccessTime, LastWriteTime: TFileTime;
    Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow: Cardinal;
  end;
  TFinalizationHandles = array of THandle;

function FinalizationOpenFile(FileName: String; Access, Share: Cardinal;
  Security: NativeUInt; Creation, Flags: Cardinal; Template: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function FinalizationFileInfo(Handle: THandle; var Info: TFinalizationHandleInfo): BOOL;
  external 'GetFileInformationByHandle@kernel32.dll stdcall';
function FinalizationFinalPath(Handle: THandle; Buffer: String; Size, Flags: Cardinal): Cardinal;
  external 'GetFinalPathNameByHandleW@kernel32.dll stdcall';
function FinalizationCloseHandle(Handle: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

procedure PinFinalizationPath(FileName: String; Directory: Boolean; var Handles: TFinalizationHandles);
var
  Current, Parent, FinalPath: String;
  Access, Share, Flags, Size: Cardinal;
  Handle: THandle;
  Info: TFinalizationHandleInfo;
begin
  Current := RemoveBackslashUnlessRoot(ExpandFileName(FileName));
  Parent := RemoveBackslashUnlessRoot(ExtractFileDir(Current));
  if (Parent <> '') and (CompareText(Current, Parent) <> 0) then
    PinFinalizationPath(Parent, True, Handles);
  Access := $80000000; Share := 1; Flags := $00200000;
  if Directory then begin
    Access := $80; Share := 3; Flags := $02200000;
  end;
  Handle := FinalizationOpenFile(SafetyWin32Path(Current), Access, Share, 0, 3, Flags, 0);
  if Handle = THandle(-1) then RaiseException('无法锁定安装收尾助手路径：' + Current);
  { Keep all parents and the read-only executable pinned across hash and Exec.
    No FILE_SHARE_DELETE; the executable additionally denies write sharing. }
  SetArrayLength(Handles, GetArrayLength(Handles) + 1);
  Handles[GetArrayLength(Handles) - 1] := Handle;
  if not FinalizationFileInfo(Handle, Info) then RaiseException('无法校验安装收尾助手句柄。');
  if ((Info.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0) or
    (((Info.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) <> Directory) or
    ((not Directory) and (Info.Links <> 1)) then
    RaiseException('安装收尾助手路径含有链接或对象类型异常。');
  SetLength(FinalPath, 32768);
  Size := FinalizationFinalPath(Handle, FinalPath, Length(FinalPath), 0);
  if (Size = 0) or (Size >= Cardinal(Length(FinalPath))) then
    RaiseException('无法确认安装收尾助手的最终路径。');
  SetLength(FinalPath, Size);
  if CompareText(RemoveBackslashUnlessRoot(FinalPath),
    RemoveBackslashUnlessRoot(SafetyWin32Path(Current))) <> 0 then
    RaiseException('安装收尾助手的路径身份已改变。');
end;

function RunInstallerFinalization(Phase: String): Boolean;
var
  HelperPath, GuardHash, Parameters: String;
  ExitCode, I: Integer;
  Handles: TFinalizationHandles;
begin
  Result := False;
  HelperPath := ExpandConstant('{tmp}\Arkdown.Update.exe');
  try
    if not FileExists(HelperPath) then ExtractTemporaryFile('Arkdown.Update.exe');
    try
      PinFinalizationPath(HelperPath, False, Handles);
      if CompareText(GetSHA256OfFile(HelperPath), '{#InstallerFinalizeHelperSha256}') <> 0 then
        RaiseException('安装收尾助手校验未通过。');
      GuardHash := FinalizationGuardSha256;
      if Phase = 'prepare' then GuardHash := '-';
      Parameters := '--installer-finalize ' + Phase + ' "' + ExpandConstant('{app}') + '" ' +
        '{#InstalledManifestSha256} {#AppVersion} {#Edition} ' + GuardHash;
      if not Exec(HelperPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
        RaiseException('无法启动安装收尾助手。');
    finally
      for I := GetArrayLength(Handles) - 1 downto 0 do FinalizationCloseHandle(Handles[I]);
    end;
    Log(Format('Arkdown installer finalization %s: exit=%d', [Phase, ExitCode]));
    if Phase = 'prepare' then begin
      FinalizationOwnGuard := ExitCode = 0;
      if (ExitCode <> 0) and (ExitCode <> 2) then RaiseException(FinalizationFailure(ExitCode));
    end else if ExitCode <> 0 then RaiseException(FinalizationFailure(ExitCode));
    Result := True;
  except
    FinalizationError := GetExceptionMessage;
    Log('Arkdown installer finalization incomplete: ' + FinalizationError);
  end;
end;

function CompleteInstallerFinalization: Boolean;
begin
  Result := FinalizationCompleted;
  if FinalizationCompletionAttempted then Exit;
  if not FinalizationMigrated then Exit;
  { Cache failure too: a failed Check must keep the eventual Setup exit nonzero,
    rather than quietly retrying and reporting success during shutdown. }
  FinalizationCompletionAttempted := True;
  FinalizationCompleted := RunInstallerFinalization('complete');
  Result := FinalizationCompleted;
end;

function CanLaunchFinalizedApplication: Boolean;
begin
  Result := False;
  if not FinalizationMigrated or (FinalizationError <> '') then Exit;
  { Inno constructs the postinstall list only after ssPostInstall and only when
    no restart is needed. Complete once here; failed completion removes the Run
    entry itself. BeforeInstall exceptions are swallowed and are not a guard. }
  FinalizationNoRestartObserved := True;
  { Do not use skipifsilent: it would suppress this Check and the no-restart
    evidence needed before clearing the guard at silent Setup's exit. }
  if WizardSilent or not FinalizationOwnGuard then Exit;
  Result := CompleteInstallerFinalization;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    FinalizationPrepared := RunInstallerFinalization('prepare');
    if not FinalizationPrepared then RaiseException(FinalizationError);
    FinalizationGuardSha256 := Lowercase(GetSHA256OfFile(ExpandConstant('{app}\.arkdown-installer-update.ini')));
  end else if CurStep = ssPostInstall then begin
    { Never remove the old manual until Inno has completed the payload writes. }
    if FinalizationPrepared then FinalizationMigrated := RunInstallerFinalization('migrate');
    if not FinalizationMigrated then
      SuppressibleMsgBox('程序文件已写入，但安装收尾尚未完成。' + #13#10 + FinalizationError, mbError, MB_OK, IDOK);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (FinalizationError <> '') then
    WizardForm.FinishedLabel.Caption := '安装收尾尚未完成，暂未启动 Arkdown。' + #13#10 + FinalizationError;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PreviousDir: String;
  VersionMS, VersionLS: Cardinal;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#StableAppId}_is1', 'Inno Setup: App Path', PreviousDir) then begin
    if DirExists(PreviousDir) and not SamePath(PreviousDir, ExpandConstant('{app}')) then begin
      Result := '检测到已安装的 Arkdown。请使用原目录升级，以保留设置和便签：' + PreviousDir;
      Exit;
    end;
  end;
  if GetVersionNumbers(ExpandConstant('{app}\Arkdown.exe'), VersionMS, VersionLS) then begin
    if (VersionMS > {#VersionMS}) or ((VersionMS = {#VersionMS}) and (VersionLS > {#VersionLS})) then begin
      Result := '此目录中的 Arkdown 版本比安装包更新。已停止安装，避免降级覆盖。';
      Exit;
    end;
  end;
  Result := CheckRunning;
  if Result = '' then Result := CheckFileSafety;
end;

function InitializeUninstall: Boolean;
var
  MessageText: String;
begin
  MessageText := CheckRunning;
  Result := MessageText = '';
  if not Result then SuppressibleMsgBox(MessageText, mbError, MB_OK, IDOK);
end;

function GetCustomSetupExitCode: Integer;
begin
  { Inno invokes this only after success with an otherwise-zero exit code.
    Also require its no-restart postinstall-list signal: manual Setup may omit
    /RESTARTEXITCODE=8, so a zero default exit alone cannot authorize completion. }
  Result := 0;
  if not FinalizationNoRestartObserved then begin
    Result := 9;
    Log('Update guard retained; no completed, non-restart installation observed.');
  end else if not CompleteInstallerFinalization then begin
    Result := 9;
    Log('Update guard retained; installation finalization requires repair.');
    if FinalizationError <> '' then
      SuppressibleMsgBox('安装收尾尚未完成。' + #13#10 + FinalizationError, mbError, MB_OK, IDOK);
  end;
end;

procedure RemoveOwnedAutostart;
var
  Names: TArrayOfString;
  I: Integer;
  Value, MainCommand, NoteCommand, RunKey: String;
begin
  RunKey := 'Software\Microsoft\Windows\CurrentVersion\Run';
  MainCommand := '"' + ExpandConstant('{app}\Arkdown.exe') + '" --arkdown-autostart';
  NoteCommand := '"' + ExpandConstant('{app}\Arknote.exe') + '" --arkdown-autostart';
  if RegGetValueNames(HKCU, RunKey, Names) then
    for I := 0 to GetArrayLength(Names)-1 do
      if RegQueryStringValue(HKCU, RunKey, Names[I], Value) then
        if (CompareText(Value, MainCommand) = 0) or (CompareText(Value, NoteCommand) = 0) then
          RegDeleteValue(HKCU, RunKey, Names[I]);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  MessageText: String;
begin
  if CurUninstallStep = usUninstall then begin
    { The confirmation may have been left open while the application restarted. }
    MessageText := CheckRunning;
    if MessageText = '' then MessageText := CheckFileSafety;
    if MessageText <> '' then begin
      SuppressibleMsgBox(MessageText, mbError, MB_OK, IDOK);
      Abort;
    end;
    RemoveOwnedAssociations;
    RemoveOwnedAutostart;
  end;
end;
