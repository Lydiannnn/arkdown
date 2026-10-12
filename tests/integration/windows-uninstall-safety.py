"""Exercise embedded cleanup against disposable HKCU fixtures; never real associations."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
import winreg

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
repo, output = Path(args.repo).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
root = 'Software\\ArkdownNativeTests\\safety-' + uuid.uuid4().hex
exe = str(output / 'not-installed' / 'Arkdown.exe')
command = f'"{exe}" "%1"'
prog = 'Arkdown.Document.Markdown'
env = dict(os.environ, ARKDOWN_E2E='1', ARKDOWN_REGISTRY_TEST_ROOT=root, ARKDOWN_UNINSTALL_EXECUTABLE=exe)
include = output / 'cleanup.iss'
subprocess.run(['node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', str(repo / 'scripts/build-uninstall-associations.ts'), str(include)], check=True, shell=False)
encoded = ''.join(re.findall(r"^\s+'([A-Za-z0-9+/=]+)'", include.read_text('utf-8-sig'), re.M))
results = []

def put(key, name, value, kind=winreg.REG_SZ):
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root + '\\' + key) as handle:
        winreg.SetValueEx(handle, name, 0, kind, value)

def read(key, name=''):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root + '\\' + key) as handle:
            return winreg.QueryValueEx(handle, name)
    except FileNotFoundError:
        return None

def clear(key=root):
    assert key == root or key.startswith(root + '\\')
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ | winreg.KEY_WRITE) as handle:
            for _ in range(winreg.QueryInfoKey(handle)[0]):
                clear(key + '\\' + winreg.EnumKey(handle, 0))
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except FileNotFoundError:
        pass

def snapshot(key=root):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            children, count, _ = winreg.QueryInfoKey(handle)
            values = sorted(winreg.EnumValue(handle, i) for i in range(count))
            return values, {name: snapshot(key + '\\' + name) for name in sorted(winreg.EnumKey(handle, i) for i in range(children))}
    except FileNotFoundError:
        return None

def base():
    put('Classes\\' + prog + '\\shell\\open\\command', '', command)
    put('Classes\\.md', '', prog)
    put('FileExts\\.md\\UserChoice', 'ProgId', prog)
    put('FileExts\\.md\\UserChoice', 'Hash', 'fixture')
    put('Sentinel', 'unchanged', b'\x00\x01', winreg.REG_BINARY)

def run_case(name, seed, blocked=True, verify=None, overrides=None):
    clear()
    base()
    seed()
    before = snapshot()
    run_env = dict(env, **(overrides or {}))
    result = subprocess.run([str(Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                            env=run_env, shell=False, creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True, timeout=30)
    try:
        if blocked:
            assert result.returncode != 0, 'ambiguous state was accepted'
            assert snapshot() == before, 'preflight failure changed registry'
        else:
            assert result.returncode == 0, 'normal cleanup failed'
        if verify:
            verify()
        assert read('Sentinel', 'unchanged') == (b'\x00\x01', winreg.REG_BINARY)
        results.append(dict(case=name, passed=True, exitCode=result.returncode))
    except AssertionError as error:
        results.append(dict(case=name, passed=False, exitCode=result.returncode, failure=str(error)))

def gone(key, name=''):
    assert read(key, name) is None, 'owned reference survived: ' + key

try:
    for label, value, kind in [('multi-string', [command], winreg.REG_MULTI_SZ), ('expand-string', command, winreg.REG_EXPAND_SZ)]:
        run_case('typed command: ' + label, lambda value=value, kind=kind: put('Classes\\' + prog + '\\shell\\open\\command', '', value, kind))
    run_case('typed extension fallback', lambda: put('Classes\\.md', '', prog, winreg.REG_EXPAND_SZ))
    for text in ['{broken', '{"version":1}', '{"version":"1","previous":null}', '{"version":true,"previous":null}',
                 '[{"version":1,"previous":null}]', '{"version":1,"previous":{"kind":"string","data":"Foreign"}}',
                 '{"version":1,"previous":{"kind":"Binary","data":[]}}']:
        run_case('invalid saved fallback: ' + text, lambda text=text: put('DefaultApplicationsState', '.md', text))
    run_case('delegated command', lambda: put('Classes\\' + prog + '\\shell\\open\\command', 'DelegateExecute', '{foreign-handler}'))
    run_case('redirected ProgID', lambda: put('Classes\\' + prog + '\\CurVer', '', 'Foreign.Editor'))
    run_case('nonstandard default verb', lambda: put('Classes\\' + prog + '\\shell', '', 'ForeignOpen'))
    run_case('unknown UserChoice value', lambda: put('FileExts\\.md\\UserChoice', 'foreign', 'keep'))
    run_case('protected selection', lambda: put('FileExts\\.txt\\UserChoiceLatest', 'ProgId', prog))
    for extension in ['.中文', '.c++', '.with space']:
        run_case('non-ASCII/punctuation extension ' + extension,
                 lambda extension=extension: (put('Classes\\' + extension, '', prog), put('FileExts\\' + extension + '\\UserChoice', 'ProgId', prog)),
                 blocked=False, verify=lambda extension=extension: (gone('Classes\\' + extension), gone('FileExts\\' + extension + '\\UserChoice', 'ProgId')))
    run_case('invalid isolation root', lambda: None, overrides={'ARKDOWN_REGISTRY_TEST_ROOT': root + '\\..\\Classes'})
    run_case('relative executable', lambda: None, overrides={'ARKDOWN_UNINSTALL_EXECUTABLE': 'relative\\Arkdown.exe'})
    run_case('unexpected executable', lambda: None, overrides={'ARKDOWN_UNINSTALL_EXECUTABLE': str(output / 'Other.exe')})
    def foreign_verify():
        assert read('FileExts\\.md\\UserChoice', 'ProgId') == ('Foreign.Editor', winreg.REG_SZ)
        assert read('Classes\\.md') == ('Foreign.Editor', winreg.REG_SZ)
    run_case('foreign defaults preserved', lambda: (put('FileExts\\.md\\UserChoice', 'ProgId', 'Foreign.Editor'), put('Classes\\.md', '', 'Foreign.Editor')), False, foreign_verify)
    def other_verify():
        assert read('Classes\\' + prog + '\\shell\\open\\command') == ('"C:\\Other\\Arkdown.exe" "%1"', winreg.REG_SZ)
        assert read('FileExts\\.md\\UserChoice', 'ProgId') == (prog, winreg.REG_SZ)
    run_case('another installation preserved', lambda: put('Classes\\' + prog + '\\shell\\open\\command', '', '"C:\\Other\\Arkdown.exe" "%1"'), False, other_verify)
finally:
    clear()
    (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps(results, ensure_ascii=False, indent=2))
raise SystemExit(1 if any(not case['passed'] for case in results) else 0)
