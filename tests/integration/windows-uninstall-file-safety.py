"""Opt-in native uninstall safety checks; all fixture files and shortcuts stay in --output.

python tests/integration/windows-uninstall-file-safety.py --repo . --iscc PATH --output DIR
Use --source PATH to characterize a saved Arkdown.iss before a fix. Each invocation
uses a new AppId, a new output child, no Windows uninstall registration, and only
HKCU\\Software\\ArkdownNativeTests\\file-safety-<uuid> for registry fixtures.
Artifacts are retained. No real application is launched and no user shortcut is used.
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback
import uuid
import winreg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--iscc', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source', help='Optional saved installer source for red characterization')
    parser.add_argument('--casefilter', help='Comma-separated case names; omitted runs all cases')
    args = parser.parse_args()
    repo = Path(args.repo).resolve()
    token = uuid.uuid4().hex
    output = Path(args.output).resolve() / ('run-' + token)
    output.mkdir(parents=True, exist_ok=False)
    root = 'Software\\ArkdownNativeTests\\file-safety-' + token
    env = dict(os.environ, ARKDOWN_E2E='1', ARKDOWN_REGISTRY_TEST_ROOT=root,
               PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    records = []
    links = []
    owned_processes = []

    def run(argv, timeout=90):
        for attempt in range(20):
            try:
                return subprocess.run([str(x) for x in argv], shell=False, env=env,
                                      creationflags=subprocess.CREATE_NO_WINDOW, timeout=timeout,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            except OSError as error:
                if error.winerror != 32 or attempt == 19:
                    raise
                time.sleep(0.1)

    def require_run(argv):
        result = run(argv)
        for _ in range(2):
            if result.returncode != 2 or b'EndUpdateResource failed' not in result.stdout:
                break
            # Transient compiler output contention; never change antivirus settings.
            time.sleep(0.5)
            result = run(argv)
        assert result.returncode == 0, (result.returncode, result.stdout[-3000:])

    def spawn_test(argv, **options):
        for attempt in range(20):
            try:
                return subprocess.Popen(argv, shell=False, **options)
            except OSError as error:
                if error.winerror != 32 or attempt == 19:
                    raise
                time.sleep(0.1)

    def put(key, name, value):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root + '\\' + key) as handle:
            winreg.SetValueEx(handle, name, 0, winreg.REG_SZ, value)

    def read(key, name=''):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root + '\\' + key) as handle:
                return winreg.QueryValueEx(handle, name)[0]
        except FileNotFoundError:
            return None

    def cleanup_key(key):
        assert key == root or key.startswith(root + '\\')
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ | winreg.KEY_WRITE) as handle:
                while winreg.QueryInfoKey(handle)[0]:
                    cleanup_key(key + '\\' + winreg.EnumKey(handle, 0))
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except FileNotFoundError:
            pass

    def sha(file):
        return hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None

    def ps_file(name, text):
        script = output / (name + '.ps1')
        script.write_text(text, encoding='utf-8-sig')
        return script

    def quote_ps(value):
        return "'" + str(value).replace("'", "''") + "'"

    def run_ps(script):
        encoded = base64.b64encode(script.read_text('utf-8-sig').encode('utf-16le')).decode('ascii')
        require_run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])

    source_path = Path(args.source).resolve() if args.source else repo / 'installer/windows/Arkdown.iss'
    source = source_path.read_text('utf-8-sig')
    assert '#define StableAppId "ArkVibe.Arkdown"' in source
    source = source.replace('#define StableAppId "ArkVibe.Arkdown"', '#define StableAppId "Arkdown.FileSafety.' + token + '"')
    source = source.replace('[Setup]', '[Setup]\nCreateUninstallRegKey=no', 1)
    # These are fixture-only destination substitutions, including future ownership checks.
    source = source.replace('{group}', '{app}\\test-shortcuts\\group')
    source = source.replace('{autodesktop}', '{app}\\test-shortcuts\\desktop')
    source = source.replace("'Software\\Microsoft\\Windows\\CurrentVersion\\Run'", "'" + root + "\\Run'")
    fixture = output / 'fixture.iss'
    fixture.write_text(source, encoding='utf-8-sig')
    helper_source = output / 'Busy.cs'
    helper_source.write_text('using System; using System.IO; using System.Threading;\n'
                            'class Busy { static void Main(string[] args) { '
                            'if(args.Length != 1) return; '
                            'for(int i=0;i<1200 && !File.Exists(args[0]);i++) Thread.Sleep(100); } }', 'utf-8')
    helper = output / 'Arkdown.exe'
    csc = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    require_run([csc, '/nologo', '/target:winexe', '/out:' + str(helper), helper_source])
    payload = output / 'component.bin'
    payload.write_bytes(b'installed component bytes')
    template = output / 'template.md'
    template.write_text('# template\n', 'utf-8')
    filelist = output / 'files.iss'
    filelist.write_text(
        f'Source: "{helper}"; DestDir: "{{app}}"; Flags: ignoreversion\n'
        f'Source: "{helper}"; DestDir: "{{app}}"; DestName: "Arknote.exe"; Flags: ignoreversion\n'
        f'Source: "{payload}"; DestDir: "{{app}}\\resources"; Flags: ignoreversion\n'
        f'Source: "{template}"; DestDir: "{{app}}\\初始工作区"; Flags: onlyifdoesntexist uninsneveruninstall\n', 'utf-8-sig')
    include = output / 'cleanup.iss'
    require_run(['node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
                 repo / 'scripts/build-uninstall-associations.ts', include])
    definitions = ['/DAppVersion=1.0.2', '/DEdition=Lite', '/DVersionMS=65536', '/DVersionLS=131072',
                   '/DRepoRoot=' + str(repo), '/DOutputDir=' + str(output),
                   '/DPayloadFileList=' + str(filelist), '/DAssociationCleanupIncludeFile=' + str(include),
                   '/DUninstallRegistryTestRoot=' + root]
    require_run([args.iscc, '/Qp', *definitions, fixture])
    setup = output / 'Arkdown-1.0.2-Lite-Windows-x64-Setup.exe'
    flags = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']

    def prepare(label, installer=setup):
        cleanup_key(root)
        target = output / label / 'app'
        require_run([installer, *flags, '/DIR=' + str(target), '/TASKS=desktopicon,arknotedesktopicon',
                     '/LOG=' + str(output / (label + '-install.log'))])
        sentinel_files = {
            'portable-data/settings.json': b'{"fixture":"preserved"}',
            'temp/drafts/unsaved.md': b'unsaved draft',
            'user-document.md': b'user document',
            '初始工作区/template.md': b'user modified template',
        }
        for relative, content in sentinel_files.items():
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
        command = '"' + str(target / 'Arkdown.exe') + '" "%1"'
        put('Classes\\Arkdown.Document.Markdown\\shell\\open\\command', '', command)
        put('Classes\\.md', '', 'Arkdown.Document.Markdown')
        return target, sentinel_files, command

    def assert_preserved(target, contents):
        for relative, expected in contents.items():
            assert (target / relative).read_bytes() == expected, 'User file changed: ' + relative

    def uninstall(target, label):
        return run([target / 'uninstall/unins000.exe', *flags,
                    '/LOG=' + str(output / (label + '-uninstall.log'))])

    def assert_stopped(target, contents, command, before, result):
        assert sha(target / 'Arkdown.exe') == before, 'Uninstall removed the program instead of stopping'
        assert (target / 'resources/component.bin').exists(), 'Uninstall partially removed the payload'
        assert read('Classes\\Arkdown.Document.Markdown\\shell\\open\\command') == command, 'Guard ran after registry mutation'
        assert_preserved(target, contents)
        assert result.returncode != 0, 'Rejected uninstall must report nonzero exit'

    def dialog_uninstall(target, label, after_confirmation=None):
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        class Entry(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                        ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                        ('parent', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                        ('image', wintypes.WCHAR * 260)]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.GetDlgItem.restype = wintypes.HWND
        user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        user32.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
        user32.GetDlgCtrlID.argtypes = [wintypes.HWND]
        child = spawn_test([str(target / 'uninstall/unins000.exe'), '/NORESTART',
                       '/LOG=' + str(output / (label + '-uninstall.log'))], env=env)
        owned_processes.append(child)
        start = time.monotonic()
        clicked = False
        while time.monotonic() - start < 40 and child.poll() is None:
            snapshot = kernel32.CreateToolhelp32Snapshot(2, 0)
            entry = Entry(); entry.size = ctypes.sizeof(entry)
            parents = {}
            try:
                more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
                while more:
                    parents[entry.pid] = entry.parent
                    more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
            finally:
                kernel32.CloseHandle(snapshot)
            pids = {child.pid}
            for _ in range(8):
                pids.update(pid for pid, parent in parents.items() if parent in pids)
            windows = []
            @callback_type
            def inspect(hwnd, _):
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value in pids:
                    windows.append(hwnd)
                return True
            user32.EnumWindows(inspect, 0)
            for hwnd in windows:
                no_button = user32.GetDlgItem(hwnd, 7)
                if no_button and not clicked:
                    if after_confirmation:
                        after_confirmation()
                    button_id = 6 if after_confirmation else 7
                    user32.PostMessageW(hwnd, 0x111, button_id, user32.GetDlgItem(hwnd, button_id))
                    clicked = True
                elif clicked:
                    # Task-dialog buttons can be nested rather than immediate children.
                    @callback_type
                    def close_ok(control, _):
                        if user32.GetDlgCtrlID(control) == 1:
                            user32.PostMessageW(control, 0xF5, 0, 0)  # BM_CLICK
                        return True
                    user32.EnumChildWindows(hwnd, close_ok, 0)
                    # Windows may ignore BM_CLICK on an inactive message box. Once
                    # our own log confirms the safety error, closing that
                    # process's windows is equivalent to dismissing the error; the
                    # production handler always aborts after this message returns.
                    current_log = output / (label + '-uninstall.log')
                    if after_confirmation and current_log.exists():
                        log_text = current_log.read_text('utf-8-sig')
                        if 'Message box (OK):' in log_text and (
                                '仍在运行：Arkdown.exe' in log_text or '安装目录含有链接' in log_text):
                            user32.PostMessageW(hwnd, 0x10, 0, 0)  # WM_CLOSE
            time.sleep(0.05)
        assert clicked, 'Test process confirmation did not appear'
        child.wait(timeout=5)
        return child

    def normal_case():
        target, contents, _ = prepare('normal')
        result = uninstall(target, 'normal')
        assert result.returncode == 0
        assert not (target / 'Arkdown.exe').exists()
        assert not (target / 'resources/component.bin').exists()
        assert_preserved(target, contents)

    def junction_case():
        target, contents, command = prepare('junction')
        before = sha(target / 'Arkdown.exe')
        resources = target / 'resources'
        resources.rename(target / 'original-resources')
        external = output / 'external'
        external.mkdir()
        sentinel = external / 'component.bin'
        sentinel.write_bytes(b'external file must never be deleted')
        make_link = ps_file('junction', '$ErrorActionPreference = "Stop"\nNew-Item -ItemType Junction -Path '
                            + quote_ps(resources) + ' -Target ' + quote_ps(external) + ' | Out-Null\n')
        run_ps(make_link)
        links.append(resources)
        result = uninstall(target, 'junction')
        assert sentinel.exists() and sentinel.read_bytes() == b'external file must never be deleted', 'External junction target was deleted'
        assert_stopped(target, contents, command, before, result)

    def late_junction_case():
        target, contents, command = prepare('late-junction')
        before = sha(target / 'Arkdown.exe')
        external = output / 'late-external'
        external.mkdir()
        sentinel = external / 'component.bin'
        sentinel.write_bytes(b'late external file must never be deleted')
        resources = target / 'resources'
        def replace_after_confirmation():
            resources.rename(target / 'original-resources')
            script = ps_file('late-junction', '$ErrorActionPreference = "Stop"\nNew-Item -ItemType Junction -Path '
                             + quote_ps(resources) + ' -Target ' + quote_ps(external) + ' | Out-Null\n')
            run_ps(script)
            links.append(resources)
        result = dialog_uninstall(target, 'late-junction', replace_after_confirmation)
        assert sentinel.read_bytes() == b'late external file must never be deleted'
        assert_stopped(target, contents, command, before, result)

    def shortcut_case(extension):
        label = 'foreign-' + extension
        target, contents, command = prepare(label)
        before = sha(target / 'Arkdown.exe')
        shortcut = target / 'test-shortcuts/desktop' / ('Arkdown.' + extension)
        if extension == 'lnk':
            foreign = output / 'foreign-target.exe'
            foreign.write_bytes(b'not executed')
            script = ps_file('shortcut', '$ErrorActionPreference = "Stop"\n$w = New-Object -ComObject WScript.Shell\n'
                             '$s = $w.CreateShortcut(' + quote_ps(shortcut) + ')\n$s.TargetPath = '
                             + quote_ps(foreign) + '\n$s.Save()\n')
            run_ps(script)
        else:
            shortcut.write_bytes(b'user owned pif sentinel')
        expected = shortcut.read_bytes()
        result = uninstall(target, label)
        try:
            assert shortcut.exists() and shortcut.read_bytes() == expected, 'Foreign shortcut was deleted or changed'
            assert_stopped(target, contents, command, before, result)
        finally:
            # Isolated shortcut cleanup avoids carrying a foreign fixture into the next install.
            if shortcut.exists():
                shortcut.unlink()

    def cancel_case():
        target, contents, command = prepare('cancel')
        before = sha(target / 'Arkdown.exe')
        dialog_uninstall(target, 'cancel')
        assert sha(target / 'Arkdown.exe') == before
        assert read('Classes\\Arkdown.Document.Markdown\\shell\\open\\command') == command
        assert_preserved(target, contents)
        assert 'Arkdown association cleanup:' not in (output / 'cancel-uninstall.log').read_text('utf-8-sig')

    def late_process_case():
        target, contents, command = prepare('late-process')
        before = sha(target / 'Arkdown.exe')
        marker = output / 'stop-busy'
        busy = []
        def start_busy():
            child = spawn_test([str(target / 'Arkdown.exe'), str(marker)],
                          creationflags=subprocess.CREATE_NO_WINDOW)
            owned_processes.append(child)
            busy.append(child)
            time.sleep(0.4)
            assert child.poll() is None
        try:
            result = dialog_uninstall(target, 'late-process', start_busy)
            assert_stopped(target, contents, command, before, result)
        finally:
            marker.write_text('stop', 'utf-8')
            for child in busy:
                child.wait(timeout=10)
            time.sleep(1.2)

    def compile_variant(label, files, cleanup=include, production=False):
        build = output / label
        build.mkdir()
        file_entries = build / 'files.iss'
        file_entries.write_text(files, 'utf-8-sig')
        variant_definitions = [value for value in definitions if not value.startswith(
            ('/DOutputDir=', '/DPayloadFileList=', '/DAssociationCleanupIncludeFile='))
            and not (production and value.startswith('/DUninstallRegistryTestRoot='))]
        variant_definitions += ['/DOutputDir=' + str(build), '/DPayloadFileList=' + str(file_entries),
                                '/DAssociationCleanupIncludeFile=' + str(cleanup)]
        require_run([args.iscc, '/Qp', *variant_definitions, fixture])
        return build / setup.name

    def append_case():
        target, contents, _ = prepare('append')
        original_component = sha(target / 'resources/component.bin')
        lite_files = '\n'.join(line for line in filelist.read_text('utf-8-sig').splitlines()
                               if str(payload) not in line) + '\n'
        lite = compile_variant('lite-build', lite_files)
        require_run([lite, *flags, '/DIR=' + str(target), '/TASKS=desktopicon,arknotedesktopicon',
                     '/LOG=' + str(output / 'append-upgrade.log')])
        assert sha(target / 'resources/component.bin') == original_component, 'Lite upgrade removed retained Full component'
        assert_preserved(target, contents)
        result = uninstall(target, 'append')
        assert result.returncode == 0
        assert not (target / 'resources/component.bin').exists(), 'Appended Full uninstall entry was lost'
        assert not (target / 'Arkdown.exe').exists()
        assert_preserved(target, contents)

    def long_path_case():
        relative = 'resources/' + '/'.join(['long-component-directory'] * 6) + '/component.bin'
        long_files = filelist.read_text('utf-8-sig') + (
            f'Source: "{payload}"; DestDir: "{{app}}\\'
            + str(Path(relative).parent) + '"; Flags: ignoreversion\n')
        full = compile_variant('long-full-build', long_files)
        target, contents, _ = prepare('long-path', full)
        installed = target / relative
        assert len(str(installed)) > 260, 'Fixture must exceed MAX_PATH'
        expected = sha(installed)
        assert expected == sha(payload)
        # The ordinary fixture is the Lite subset of this full payload.
        require_run([setup, *flags, '/DIR=' + str(target), '/TASKS=desktopicon,arknotedesktopicon',
                     '/LOG=' + str(output / 'long-path-lite-upgrade.log')])
        assert sha(installed) == expected, 'Lite upgrade removed retained Full deep component'
        assert_preserved(target, contents)
        result = uninstall(target, 'long-path')
        assert result.returncode == 0
        assert not installed.exists(), 'Deep Full uninstall entry was lost'
        assert not (target / 'Arkdown.exe').exists()
        assert_preserved(target, contents)

    def environment_case():
        # Probe performs no registry access: abort before native file/log cleanup.
        probe = "if ([string]::IsNullOrEmpty($env:ARKDOWN_E2E) -and [string]::IsNullOrEmpty($env:ARKDOWN_REGISTRY_TEST_ROOT)) { exit 21 }; exit 22"
        encoded = base64.b64encode(probe.encode('utf-16le')).decode('ascii')
        probe_include = output / 'probe-cleanup.iss'
        probe_include.write_text("const\n  AssociationCleanupEncoded = '" + encoded + "';\n", 'utf-8-sig')
        production = compile_variant('probe-build', filelist.read_text('utf-8-sig'), probe_include, production=True)
        target, contents, command = prepare('environment', production)
        before = sha(target / 'Arkdown.exe')
        result = uninstall(target, 'environment')
        log = (output / 'environment-uninstall.log').read_text('utf-8-sig')
        assert 'Arkdown association cleanup: started=1, exit=21' in log, 'Production uninstaller inherited the registry test environment'
        assert_stopped(target, contents, command, before, result)

    try:
        cases = [('normal', normal_case), ('cancel', cancel_case), ('junction', junction_case),
                 ('foreign-lnk', lambda: shortcut_case('lnk')), ('foreign-pif', lambda: shortcut_case('pif')),
                 ('late-process', late_process_case), ('late-junction', late_junction_case),
                 ('append', append_case), ('long-path', long_path_case), ('environment', environment_case)]
        selected = set(args.casefilter.split(',')) if args.casefilter else {label for label, _ in cases}
        assert selected and selected <= {label for label, _ in cases}, 'Unknown or empty --casefilter'
        for label, case in cases:
            if label not in selected:
                continue
            start = time.monotonic()
            try:
                case()
                record = dict(case=label, passed=True)
            except Exception as error:
                record = dict(case=label, passed=False, error=str(error), traceback=traceback.format_exc())
            record['elapsedMs'] = round((time.monotonic() - start) * 1000)
            records.append(record)
            print(json.dumps({key: value for key, value in record.items() if key != 'traceback'}, ensure_ascii=False), flush=True)
    finally:
        for child in owned_processes:
            if child.poll() is None:
                # Only processes started by this test are eligible, never image-name matching.
                child.terminate()
                child.wait(timeout=10)
        for junction in links:
            assert junction.is_relative_to(output)
            if junction.is_junction():
                os.rmdir(junction)  # Remove the link only, never recurse into its target.
        cleanup_key(root)
        report = dict(source=str(source_path), sourceSha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
                      fixtureSha256=sha(fixture), registryRoot=root, output=str(output), checks=records)
        (output / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
        print('Results: ' + str(output / 'results.json'), flush=True)
    return 0 if records and all(row['passed'] for row in records) else 1


if __name__ == '__main__':
    raise SystemExit(main())
