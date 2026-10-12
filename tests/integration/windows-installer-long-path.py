"""Opt-in Inno-native safety scan regression; never installs or launches Arkdown.

python tests/integration/windows-installer-long-path.py --repo . --iscc PATH --output DIR
Optional --source PATH runs the same checks against a saved pre-fix Arkdown.iss.
Fixtures, generated source and logs are retained under a unique output child.
UNC conversion is tested without requiring a network share; disk scans use NTFS.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--iscc', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source')
    args = parser.parse_args()
    repo = Path(args.repo).resolve()
    source_path = Path(args.source).resolve() if args.source else repo / 'installer/windows/Arkdown.iss'
    source = source_path.read_text('utf-8-sig')
    output = Path(args.output).resolve() / ('scan-' + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')

    def run(argv, log):
        result = subprocess.run([str(arg) for arg in argv], shell=False, env=env,
                                creationflags=subprocess.CREATE_NO_WINDOW,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        log.write_bytes(result.stdout)
        return result.returncode

    def extended(path):
        return '\\\\?\\' + str(path)

    def literal(value):
        return "'" + str(value).replace("'", "''") + "'"

    # A path over MAX_PATH with ordinary file and directory names, including Unicode.
    target = output / 'app'
    deep = target
    while len(str(deep)) < 320:
        deep = deep / '较深安装目录-long-segment'
    Path(extended(deep)).mkdir(parents=True)
    sentinel = Path(extended(deep / 'payload.txt'))
    sentinel.write_bytes(b'long-path payload must remain unchanged')
    outside = output / 'outside'
    outside.mkdir()
    (outside / 'sentinel.txt').write_bytes(b'junction target must remain unchanged')
    (outside / 'child').mkdir()

    # Create junctions at a short location, then move the link itself into a long
    # parent using the native extended path. This needs no symlink privilege.
    junction = output / 'link'
    ps = output / 'junction.ps1'
    ps.write_text("$ErrorActionPreference = 'Stop'\nNew-Item -ItemType Junction -Path "
                  + literal(junction) + ' -Target ' + literal(outside) + ' | Out-Null\n',
                  encoding='utf-8-sig')
    encoded = base64.b64encode(ps.read_text('utf-8-sig').encode('utf-16le')).decode('ascii')
    assert run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
               output / 'junction-create.log') == 0, 'Could not create test junction'
    long_link = deep / 'linked-directory'
    os.rename(extended(junction), extended(long_link))

    # Extract the actual production functions, not a translated or mocked scanner.
    code = source[source.index('function SamePath('):source.index('procedure AssertOwnedShortcut(')]
    code = code.replace("ExpandConstant('{app}')", literal(target))
    normalize_tests = "Log('FAIL normalization: helper missing');"
    if 'function SafetyWin32Path(' in code:
        pairs = [
            ('drive', r'C:\folder\file.txt', '\\\\?\\C:\\folder\\file.txt'),
            ('drive-root', 'C:\\', '\\\\?\\C:\\'),
            ('unc', r'\\server\share\folder\file.txt', '\\\\?\\UNC\\server\\share\\folder\\file.txt'),
            ('extended-drive', r'\\?\C:\folder\file.txt', '\\\\?\\C:\\folder\\file.txt'),
            ('extended-unc', r'\\?\UNC\server\share\folder\file.txt', '\\\\?\\UNC\\server\\share\\folder\\file.txt'),
            ('dot-segments', r'C:\folder\child\..\file.txt', '\\\\?\\C:\\folder\\file.txt'),
        ]
        normalize_tests = '\n'.join(
            f'if SafetyWin32Path({literal(value)}) = {literal(expected)} then '
            f"Log('PASS normalize-{name}') else Log('FAIL normalize-{name}');"
            for name, value, expected in pairs)

    # The plain-tree case uses a sibling without the junction. The linked tree
    # deliberately sorts after ordinary content: enumeration must remain fail closed.
    plain = output / 'plain'
    plain_deep = plain
    while len(str(plain_deep)) < 320:
        plain_deep = plain_deep / '较深安装目录-long-segment'
    Path(extended(plain_deep)).mkdir(parents=True)
    Path(extended(plain_deep / 'payload.txt')).write_bytes(b'plain deep payload')
    cases = [
        ('long-tree', f'AssertPlainTree({literal(plain)})', ''),
        ('long-ancestors', f'AssertPlainAncestors({literal(plain_deep)})', ''),
        ('missing-tree-fails-closed', f'AssertPlainTree({literal(plain_deep / "missing" / "child")})', '无法完整检查安装目录'),
        ('long-tree-junction', f'AssertPlainTree({literal(target)})', '安装目录含有链接'),
        # Inspect the link itself so Inno's process-level RedirectionGuard does
        # not reject traversal into its target before our attribute check runs.
        ('long-ancestor-junction', f'AssertPlainAncestors({literal(long_link)})', '安装路径含有目录链接或重解析点'),
    ]
    assertions = '\n'.join(
        "ErrorText := '';\ntry\n  " + call + ';\nexcept\n  ErrorText := GetExceptionMessage;\n'
        "  Log('DETAIL " + name + " ' + ErrorText);\nend;\n"
        + (f'if Pos({literal(expected)}, ErrorText) > 0' if expected else "if ErrorText = ''")
        + f" then Log('PASS {name}') else Log('FAIL {name}');"
        for name, call, expected in cases)
    script = output / 'probe.iss'
    script.write_text('[Setup]\nAppName=Arkdown Safety Scan Probe\nAppVersion=1.0\n'
                      'DefaultDirName={tmp}\\ArkdownScanProbe\nPrivilegesRequired=lowest\n'
                      'Uninstallable=no\nCreateUninstallRegKey=no\nOutputBaseFilename=scan-probe\n'
                      '[Code]\n' + code + '\nfunction InitializeSetup: Boolean;\n'
                      'var ErrorText: String;\nbegin\n' + assertions + '\n' + normalize_tests
                      + '\nResult := False;\nend;\n', 'utf-8-sig')
    assert run([args.iscc, '/Qp', '/O' + str(output), script], output / 'compile.log') == 0, 'Probe compile failed'
    log = output / 'probe.log'
    assert run([output / 'scan-probe.exe', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/LOG=' + str(log)],
               output / 'process.log') == 1, 'Read-only probe must abort before installing'
    log_text = log.read_text('utf-8-sig')
    records = [line.split('   ', 1)[-1] for line in log_text.splitlines() if '   PASS ' in line or '   FAIL ' in line]
    expected_names = {name for name, _, _ in cases} | {
        'normalize-drive', 'normalize-drive-root', 'normalize-unc',
        'normalize-extended-drive', 'normalize-extended-unc', 'normalize-dot-segments',
    }
    record_names = [row.split(' ', 1)[1] for row in records]
    assert len(record_names) == len(set(record_names)), 'Probe reported duplicate safety checks'
    assert set(record_names) == expected_names, 'Probe did not report exactly the complete safety check set'
    assert sentinel.read_bytes() == b'long-path payload must remain unchanged'
    assert (outside / 'sentinel.txt').read_bytes() == b'junction target must remain unchanged'
    result = dict(sourceSha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
                  longPathLength=len(str(plain_deep)), checks=records,
                  passed=all(row.startswith('PASS ') for row in records))
    (output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    print('Evidence: ' + str(output), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
