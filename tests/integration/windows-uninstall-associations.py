"""Compile the real installer against disposable files and isolated association keys."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import winreg

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--iscc', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
repo, output = Path(args.repo).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
token = uuid.uuid4().hex
root = 'Software\\ArkdownNativeTests\\uninstall-' + token
target = output / ('app-' + token)
env = dict(os.environ, ARKDOWN_E2E='1', ARKDOWN_REGISTRY_TEST_ROOT=root)
exe = str(target / 'Arkdown.exe')
records = []

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
            while True:
                try:
                    child = winreg.EnumKey(handle, 0)
                except OSError:
                    break
                cleanup_key(key + '\\' + child)
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except FileNotFoundError:
        pass

def run(command, label, expected=0):
    start = time.monotonic()
    result = subprocess.run(command, shell=False, env=env, creationflags=subprocess.CREATE_NO_WINDOW, timeout=90,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert result.returncode == expected, (label, result.returncode, result.stdout[-2000:])
    records.append(dict(case=label, exitCode=result.returncode, elapsedMs=round((time.monotonic()-start)*1000)))

def cancel_uninstall(uninstaller):
    # Only operate a confirmation belonging to this test's process tree.
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
    child = subprocess.Popen([str(uninstaller), '/LOG=' + str(output/'cancel.log')], env=env, shell=False)
    started = time.monotonic()
    found = []
    while time.monotonic() - started < 15 and child.poll() is None and not found:
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
        for _ in range(5):
            pids.update(pid for pid, parent in parents.items() if parent in pids)
        @callback_type
        def inspect(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            button = user32.GetDlgItem(hwnd, 7) if pid.value in pids else None
            if button:
                found.append(round((time.monotonic()-started)*1000))
                user32.PostMessageW(hwnd, 0x111, 7, button)
            return True
        user32.EnumWindows(inspect, 0)
        if not found:
            time.sleep(0.05)
    assert found, 'test confirmation did not appear'
    child.wait(timeout=10)
    records.append(dict(case='cancel confirmation', firstDialogMs=found[0], exitCode=child.returncode))

source = (repo / 'installer/windows/Arkdown.iss').read_text('utf-8-sig')
source = source.replace('#define StableAppId "ArkVibe.Arkdown"', '#define StableAppId "Arkdown.Test.' + token + '"')
source = source.replace('[Setup]', '[Setup]\nCreateUninstallRegKey=no')
source = re.sub(r'\[Icons\].*?(?=\[Run\])', '', source, flags=re.S)
source = source.replace('{group}', str(output / 'test-menu')).replace('{autodesktop}', str(output / 'test-desktop'))
fixture = output / 'fixture.iss'
fixture.write_text(source, encoding='utf-8-sig')
payload = output / 'payload.txt'
payload.write_text('disposable payload', 'utf-8')
filelist = output / 'files.iss'
filelist.write_text(f'Source: "{payload}"; DestDir: "{{app}}"; DestName: "Arkdown.exe"; Flags: ignoreversion\n', 'utf-8-sig')
definitions = ['/DAppVersion=1.0.2', '/DEdition=Lite', '/DVersionMS=65536', '/DVersionLS=131072',
               '/DRepoRoot=' + str(repo), '/DOutputDir=' + str(output), '/DPayloadFileList=' + str(filelist),
               '/DUninstallRegistryTestRoot=' + root]
if 'AssociationCleanupIncludeFile' in source:
    include = output / 'cleanup.iss'
    run(['node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', str(repo / 'scripts/build-uninstall-associations.ts'), str(include)], 'generate')
    definitions.append('/DAssociationCleanupIncludeFile=' + str(include))
run([args.iscc, '/Qp', *definitions, str(fixture)], 'compile')
setup = output / 'Arkdown-1.0.2-Lite-Windows-x64-Setup.exe'
flags = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=']
try:
    run([str(setup), *flags, '/DIR=' + str(target), '/LOG=' + str(output/'install.log')], 'install')
    put('Classes\\Arkdown.Document.Markdown\\shell\\open\\command', '', f'"{exe}" "%1"')
    put('Classes\\Arkdown.Document.Markdown\\DefaultIcon', '', f'"{target}\\resources\\branding\\ark-md.ico",0')
    put('Classes\\.md', '', 'Arkdown.Document.Markdown')
    put('FileExts\\.md\\UserChoice', 'ProgId', 'Arkdown.Document.Markdown')
    put('FileExts\\.md\\UserChoice', 'Hash', 'fixture')
    put('DefaultApplicationsState', '.md', json.dumps(dict(version=1, previous=dict(kind='String', data='Previous.Editor'))))
    put('Classes\\Previous.Editor\\shell\\open\\command', '', '"C:\\Previous.exe" "%1"')
    put('Classes\\Arkdown.Document.Text\\shell\\open\\command', '', '"C:\\Surviving\\Arkdown.exe" "%1"')
    put('FileExts\\.txt\\UserChoice', 'ProgId', 'Arkdown.Document.Text')
    put('Capabilities', 'ApplicationIcon', f'"{exe}",0')
    put('Capabilities\\FileAssociations', '.md', 'Arkdown.Document.Markdown')
    put('Capabilities\\FileAssociations', '.txt', 'Arkdown.Document.Text')
    put('RegisteredApplications', 'Arkdown', 'Software\\Arkdown\\Capabilities')
    for prog, ext, icon in [('Arkdown.Document.Docx', '.docx', 'ark-docx.ico'), ('Arkdown.Document.OtherMarkdown', '.qmd', 'ark-markdown-other.ico')]:
        put('Classes\\' + prog + '\\shell\\open\\command', '', f'"{exe}" "%1"')
        put('Classes\\' + prog + '\\DefaultIcon', '', f'"{target}\\resources\\branding\\{icon}",0')
        put('Classes\\' + ext, '', prog)
        put('FileExts\\' + ext + '\\UserChoice', 'ProgId', 'Foreign.Editor' if ext == '.docx' else prog)
        put('Capabilities\\FileAssociations', ext, prog)
    put('Classes\\.md\\OpenWithProgids', 'Arkdown.Document.Markdown', '')
    put('Classes\\.md\\OpenWithProgids', 'Foreign.Editor', '')
    put('FileExts\\.md\\OpenWithProgids', 'Arkdown.Document.Markdown', '')
    put('Classes\\Applications\\Arkdown.exe\\shell\\open\\command', '', f'"{exe}" "%1"')
    (target/'user-document.md').write_text('user document must survive', 'utf-8')
    uninstaller = target / 'uninstall/unins000.exe'
    cancel_uninstall(uninstaller)
    assert (target/'Arkdown.exe').exists()
    assert read('FileExts\\.md\\UserChoice', 'ProgId') == 'Arkdown.Document.Markdown'
    assert 'Arkdown association cleanup:' not in (output/'cancel.log').read_text('utf-8-sig')
    # Upgrade must not execute the uninstall cleanup.
    run([str(setup), *flags, '/DIR=' + str(target)], 'upgrade')
    assert read('FileExts\\.md\\UserChoice', 'ProgId') == 'Arkdown.Document.Markdown'
    uninstaller = target / 'uninstall/unins000.exe'
    run([str(uninstaller), *flags[:3], '/LOG=' + str(output/'uninstall.log')], 'uninstall')
    assert not (target / 'Arkdown.exe').exists()
    assert read('FileExts\\.md\\UserChoice', 'ProgId') is None, 'owned UserChoice survived uninstall'
    assert read('Classes\\.md') == 'Previous.Editor', 'previous fallback was not restored'
    assert read('Classes\\Arkdown.Document.Markdown\\shell\\open\\command') is None
    assert read('Classes\\Arkdown.Document.Markdown\\DefaultIcon') is None
    assert read('FileExts\\.txt\\UserChoice', 'ProgId') == 'Arkdown.Document.Text'
    assert read('Classes\\Arkdown.Document.Text\\shell\\open\\command') == '"C:\\Surviving\\Arkdown.exe" "%1"'
    assert read('Capabilities\\FileAssociations', '.txt') == 'Arkdown.Document.Text'
    assert read('Capabilities\\FileAssociations', '.md') is None
    assert read('Classes\\.md\\OpenWithProgids', 'Arkdown.Document.Markdown') is None
    assert read('FileExts\\.md\\OpenWithProgids', 'Arkdown.Document.Markdown') is None
    assert read('Classes\\.md\\OpenWithProgids', 'Foreign.Editor') == ''
    assert read('FileExts\\.docx\\UserChoice', 'ProgId') == 'Foreign.Editor'
    assert read('FileExts\\.qmd\\UserChoice', 'ProgId') is None
    assert read('Classes\\.qmd') is None
    assert read('Classes\\Arkdown.Document.OtherMarkdown\\shell\\open\\command') is None
    assert read('Classes\\Applications\\Arkdown.exe\\shell\\open\\command') is None
    assert (target/'user-document.md').read_text('utf-8') == 'user document must survive'
    records.append(dict(case='association state', passed=True))
    encoded = ''.join(re.findall(r"^\s+'([A-Za-z0-9+/=]+)'", include.read_text('utf-8-sig'), re.M))
    env['ARKDOWN_UNINSTALL_EXECUTABLE'] = exe
    run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 'repeat cleanup')
    assert read('FileExts\\.txt\\UserChoice', 'ProgId') == 'Arkdown.Document.Text'
    # A protected choice must stop the actual uninstaller before deleting files.
    cleanup_key(root)
    run([str(setup), *flags, '/DIR=' + str(target)], 'reinstall fixture')
    put('Classes\\Arkdown.Document.Markdown\\shell\\open\\command', '', f'"{exe}" "%1"')
    put('FileExts\\.md\\UserChoiceLatest\\ProgId', 'ProgId', 'Arkdown.Document.Markdown')
    run([str(uninstaller), *flags[:3], '/LOG=' + str(output/'protected.log')], 'protected abort', expected=1)
    assert (target/'Arkdown.exe').exists()
    assert read('Classes\\Arkdown.Document.Markdown\\shell\\open\\command') == f'"{exe}" "%1"'
    cleanup_key(root + '\\FileExts\\.md\\UserChoiceLatest')
    run([str(uninstaller), *flags[:3]], 'retry after protected choice cleared')
    assert not (target/'Arkdown.exe').exists()
    cleanup_key(root)
    run([str(setup), *flags, '/DIR=' + str(target)], 'case variant fixture')
    put('Classes\\Arkdown.Document.Markdown\\shell\\open\\command', '', f'"{exe.upper()}" "%1"')
    put('Classes\\Arkdown.Document.Markdown\\DefaultIcon', '', f'"{str(target).upper()}\\RESOURCES\\BRANDING\\ARK-MD.ICO",0')
    put('Classes\\.log', '', 'Arkdown.Document.Markdown')
    put('Classes\\Old.Alias\\shell\\open\\command', '', f'"{exe}" "%1"')
    put('DefaultApplicationsState', '.log', json.dumps(dict(version=1, previous=dict(kind='String', data='Old.Alias'))))
    put('Classes\\.log\\OpenWithProgids', 'Arkdown.Document.Markdown', '')
    put('Classes\\.json', '', 'Another.Editor')
    put('Capabilities', 'ApplicationIcon', f'"{exe.upper()}",0')
    put('RegisteredApplications', 'Arkdown', 'Software\\Arkdown\\Capabilities')
    run([str(uninstaller), *flags[:3]], 'case variant and fallback-only uninstall')
    failures = []
    for key in ['Classes\\.log', 'Classes\\Arkdown.Document.Markdown\\shell\\open\\command', 'Classes\\Arkdown.Document.Markdown\\DefaultIcon']:
        if read(key) is not None:
            failures.append(key)
    if read('Capabilities', 'ApplicationIcon') is not None:
        failures.append('ApplicationIcon')
    assert failures == [], 'stale registrations after uninstall: ' + repr(failures)
    assert read('Classes\\.log\\OpenWithProgids', 'Arkdown.Document.Markdown') is None
    assert read('RegisteredApplications', 'Arkdown') is None
    assert read('Classes\\.json') == 'Another.Editor'
finally:
    cleanup_key(root)
    (output/'results.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps(records, ensure_ascii=False, indent=2))
