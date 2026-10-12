"""Read-only Inno process-check regression; never installs or uninstalls Arkdown.

Requires the same Inno compiler as the release. Executes the production CheckRunning
body, substituting only the app-directory constant with an explicit fixture path.
The diagnostic always returns False from InitializeSetup before installation starts.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--iscc', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--node', required=True)
args = parser.parse_args()
repo, output = Path(args.repo).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
source = (repo / 'installer/windows/Arkdown.iss').read_text('utf-8-sig')
body = source[source.index('function SamePath'):source.index('function PrepareToInstall')]
body = body.replace("ExpandConstant('{app}')", "ExpandConstant('{param:ProbeDir}')")
assert 'ProcessCount := Processes.Count;' in body
fixture_dir = output / 'probe-app'
fixture_dir.mkdir(exist_ok=True)
header = '''[Setup]
AppName=Arkdown Process Check Verification
AppVersion=1.0.2
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=.
OutputBaseFilename=Arkdown-Process-Check-Verification
Compression=none
SetupLogging=yes
[Code]
function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';
'''
tail = '''
function InitializeSetup: Boolean;
var
  Started: Cardinal;
  MessageText: String;
begin
  Result := False;
  Started := GetTickCount;
  MessageText := CheckRunning;
  Log(Format('ARKDOWN_PROCESS_CHECK elapsedMs=%d blocked=%d message=%s', [GetTickCount-Started, Ord(MessageText <> ''), MessageText]));
end;
'''
script = output / 'process-check.iss'
script.write_text(header + body + tail, encoding='utf-8-sig')
creation = subprocess.CREATE_NO_WINDOW
subprocess.run([args.iscc, '/Qp', str(script)], cwd=output, shell=False,
               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, creationflags=creation)
exe = output / 'Arkdown-Process-Check-Verification.exe'
results = []

def run(label, blocked):
    log = output / (label + '.log')
    started = time.perf_counter()
    result = subprocess.run([str(exe), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                             '/ProbeDir=' + str(fixture_dir), '/LOG=' + str(log)],
                            shell=False, creationflags=creation, timeout=60)
    assert result.returncode == 1, f'Unexpected diagnostic exit: {result.returncode}'
    text = log.read_text('utf-8-sig')
    match = re.search(r'ARKDOWN_PROCESS_CHECK elapsedMs=(\d+) blocked=(\d+) message=(.*)', text)
    assert match and bool(int(match[2])) == blocked, text
    assert 'InitializeSetup returned False' in text and 'Starting the installation process' not in text
    record = dict(case=label, passed=True, checkMs=int(match[1]),
                  processMs=round((time.perf_counter()-started)*1000), exitCode=result.returncode,
                  blocked=blocked, message=match[3].strip())
    results.append(record)
    print(json.dumps(record, ensure_ascii=False), flush=True)

def with_probe(relative, label, blocked):
    probe_path = (fixture_dir / relative).resolve()
    assert probe_path.is_relative_to(fixture_dir.resolve())
    probe_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.node, probe_path)
    child = subprocess.Popen([str(probe_path), '-e',
        'process.stdout.write("READY\\n");process.stdin.on("data",()=>process.exit(0));setInterval(()=>{},1000)'],
        shell=False, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=creation)
    try:
        assert child.stdout.readline().strip() == b'READY'
        run(label, blocked)
    finally:
        child.communicate(input=b'quit\n', timeout=10)
        probe_path.unlink()

run('01-idle', False)
run('02-repeat', False)
with_probe('Arkdown.exe', '03-running-main-blocked', True)
with_probe('translation-helper.exe', '04-running-helper-blocked', True)
with_probe('uninstall/probe.exe', '05-uninstaller-subdirectory-ignored', False)
(output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', 'utf-8')
