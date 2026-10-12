"""Opt-in Windows installer validation. Uses disposable data; never adopts a real install.

python windows-installer-smoke.py prepare|switch|cleanup --installers DIR --old-package DIR --work DIR
Pause between phases to run Electron checks against the installed payload.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, time, winreg

parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['prepare', 'switch', 'cleanup'])
parser.add_argument('--installers', required=True)
parser.add_argument('--old-package', required=True)
parser.add_argument('--work', required=True)
args = parser.parse_args()
work = pathlib.Path(args.work).resolve()
assert 'windows-installers' in str(work) and 'verification' in str(work), 'Use the isolated verification directory'
target = work / '覆盖升级 测试' / 'Arkdown-win32-x64'
fresh = work / '全新安装 测试' / 'Arkdown'
artifacts = pathlib.Path(args.installers).resolve()
key_path = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\ArkVibe.Arkdown_is1'
report_path = work / 'results.json'
report = json.loads(report_path.read_text('utf-8')) if report_path.exists() else {'checks': []}

def sha(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def record(name, **details):
    report['checks'].append(dict(name=name, passed=True, **details))
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
    print(name + ': PASS', flush=True)

def registration():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            return winreg.QueryValueEx(key, 'Inno Setup: App Path')[0]
    except FileNotFoundError: return None

def assert_owned(directory):
    current = registration()
    assert current and pathlib.Path(current).resolve() == directory.resolve(), 'Refusing to modify another installation'

def setup(edition, label, directory=None, success=True, executable=None):
    exe = executable or artifacts / f'Arkdown-1.0.1-{edition}-Windows-x64-Setup.exe'
    argv = [str(exe), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', '/NOICONS', '/TASKS=', '/LOG='+str(work/(label+'.log'))]
    if directory is not None: argv.append('/DIR='+str(directory))
    result = subprocess.run(argv, shell=False, timeout=300, creationflags=subprocess.CREATE_NO_WINDOW)
    assert (result.returncode == 0) == success, (label, result.returncode)
    return result.returncode

def verify(edition, directory):
    manifest = json.loads((artifacts/f'installer-{edition.lower()}-manifest.json').read_text('utf-8'))
    count = 0
    for file in manifest['files']:
        if directory == target and file['path'] == '初始工作区/01-欢迎使用.md': continue
        destination = directory/file['path']
        assert destination.is_file() and sha(destination) == file['sha256'], 'Installed payload mismatch: '+file['path']
        count += 1
    return count

def preserve():
    for relative, expected in report['sentinels'].items():
        assert sha(target/relative) == expected, 'User data changed: '+relative

def uninstall(directory, label):
    assert_owned(directory)
    result = subprocess.run([str(directory/'uninstall/unins000.exe'), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG='+str(work/(label+'.log'))],
                            shell=False, timeout=180, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, ('uninstall', result.returncode)
    assert registration() is None
    assert not (directory/'Arkdown.exe').exists() and not (directory/'Arknote.exe').exists()

if args.phase == 'prepare':
    assert registration() is None, 'A real Arkdown installation is already registered; use an isolated Windows user'
    assert not target.exists(), 'Refusing to merge test directories'
    work.mkdir(parents=True, exist_ok=True)
    old = pathlib.Path(args.old_package).resolve()
    assert not (old/'portable-data').exists() and not (old/'temp').exists(), 'Old package must be pristine'
    shutil.copytree(old, target)
    contents = {
        'portable-data/settings.json': '{"test":"installer preservation","appearance":{"editorTheme":"dark"}}',
        'portable-data/arknote/notes/note.json': '{"title":"保留的便签","content":"便签正文"}',
        'portable-data/components/test-component/readme.txt': 'previously downloaded module',
        'temp/drafts/unsaved.md': '# 未保存草稿\n不可删除',
        'temp/assets/image.txt': 'draft attachment',
        '我的文档.md': '# 不属于安装程序的文档',
        '初始工作区/01-欢迎使用.md': '# 用户修改的欢迎文档',
    }
    for relative, content in contents.items():
        file = target/relative; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(content, 'utf-8')
    report['sentinels'] = {relative:sha(target/relative) for relative in contents}
    report['oldExecutableSha256'] = sha(target/'Arkdown.exe')
    setup('Lite', '01-old-portable-upgrade', target)
    assert_owned(target); preserve()
    assert sha(target/'Arkdown.exe') != report['oldExecutableSha256']
    record('旧版 1.0.0 解压版原目录升级到 1.0.1 Lite', verifiedFiles=verify('Lite',target))
    setup('Lite', '02-reinstall-reuses-directory')
    assert_owned(target); preserve()
    record('同版本重装自动沿用目录和唯一卸载记录', verifiedFiles=verify('Lite',target))
    code=setup('Lite', '03-changed-directory-blocked', work/'错误的新目录', success=False)
    assert not (work/'错误的新目录'/'Arkdown.exe').exists(); preserve()
    record('已安装后拒绝改路径导致数据分离', exitCode=code)
    setup('Full', '04-lite-to-full')
    assert_owned(target); preserve()
    record('Lite 覆盖升级为 Full', verifiedFiles=verify('Full',target))
    report['nativeFullDirectory'] = str(target)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')

elif args.phase == 'switch':
    assert_owned(target); preserve()
    full_manifest = json.loads((artifacts/'installer-full-manifest.json').read_text('utf-8'))
    setup('Lite', '05-full-to-lite')
    assert_owned(target); preserve()
    for item in full_manifest['files']:
        if item['path'].startswith('resources/components/'):
            assert sha(target/item['path']) == item['sha256']
    record('Full 切换 Lite 保留已有组件与用户数据', verifiedFiles=verify('Lite',target))
    local_setup = target/'Arkdown-Local-Setup.exe'
    shutil.copyfile(artifacts/'Arkdown-1.0.1-Lite-Windows-x64-Setup.exe', local_setup)
    setup('Lite','06-installer-inside-app', executable=local_setup)
    preserve(); record('安装程序放在旧目录内不会被误判为运行中的应用')

    # A small test-only native program owns a process until a marker arrives (or 45s).
    csharp = work/'Busy.cs'
    csharp.write_text('using System; using System.IO; using System.Threading; using System.Reflection;\n'
      '[assembly: AssemblyFileVersion("99.0.0.0")]\n'
      'class Busy { static void Main(string[] args) { for(int i=0;i<450 && !File.Exists(args[0]);i++) Thread.Sleep(100); } }', 'utf-8')
    csc = pathlib.Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    helper = target/'resources/InstallerTestBusy.exe'
    subprocess.run([str(csc),'/nologo','/target:winexe','/out:'+str(helper),str(csharp)],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
    marker=work/'stop-busy'; assert not marker.exists()
    busy=subprocess.Popen([str(helper),str(marker)],creationflags=subprocess.CREATE_NO_WINDOW)
    before=sha(target/'resources/app.asar')
    try:
        time.sleep(0.3)
        code=setup('Lite','07-active-helper-blocked',success=False)
        assert busy.poll() is None and sha(target/'resources/app.asar') == before
        record('运行中的辅助进程阻止覆盖且不被强制终止', exitCode=code)
    finally:
        marker.write_text('stop','utf-8'); busy.wait(timeout=10); time.sleep(1.3)

    main=target/'Arkdown.exe'; backup=work/'original-Arkdown.exe'
    shutil.copyfile(main,backup); shutil.copyfile(helper,main)
    try:
        code=setup('Lite','08-downgrade-blocked',success=False)
        assert sha(main)==sha(helper); preserve()
        record('拒绝覆盖更高版本',exitCode=code)
    finally: shutil.copyfile(backup,main)
    uninstall(target,'09-uninstall-preserves-data'); preserve()
    record('卸载保留设置、便签、草稿、附件、用户文档与已改初始文档')
    assert not fresh.exists()
    setup('Lite','10-clean-install',fresh)
    assert_owned(fresh)
    record('全新安装 Lite',verifiedFiles=verify('Lite',fresh))
    report['nativeLiteDirectory']=str(fresh)
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')

else:
    assert_owned(fresh)
    uninstall(fresh,'11-fresh-uninstall')
    record('全新安装后的卸载移除程序及卸载记录')
    preserve()
    record('测试结束：旧用户数据哨兵仍逐字节保留')
