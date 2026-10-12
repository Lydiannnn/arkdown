"""Prepare a new, separately owned Codex 0.154.0 module. Never touch old release inputs."""
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tomllib
import urllib.request
import zipfile

REPO = Path(__file__).resolve().parents[1]
NEW = REPO / '.components/codex-0.154.0-preparation'
INPUT = NEW / 'inputs'
RUNTIME = NEW / '.components/codex-cli/runtime'
PUBLIC = NEW / '.components/public-codex-cli-release'
VERSION = '0.154.0'
INPUT.mkdir(parents=True, exist_ok=True)
PUBLIC.mkdir(parents=True, exist_ok=True)
SOURCES = REPO / '.components/optional-component-sources'

def fetch(name, url, expected=None):
    target = INPUT / name
    if not target.exists():
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'Arkdown-release-verification'}), timeout=90) as response, target.with_suffix(target.suffix+'.download').open('wb') as output:
            shutil.copyfileobj(response, output, 1024*1024)
        target.with_suffix(target.suffix+'.download').replace(target)
    data = target.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if expected and sha != expected:
        raise ValueError('Input checksum mismatch: '+name)
    result = dict(name=name, url=url, bytes=len(data), sha256=sha)
    print(json.dumps(result), flush=True)
    return result

def inputs():
    jobs = [
        ('codex-package-0.154.0-windows-x64.tar.gz','https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-package-x86_64-pc-windows-msvc.tar.gz','94cc5b3632769504c809f6c0364b693c0dfddc5c30c8361095d2263a07ac45a4'),
        ('codex-0.154.0-source.tar.gz','https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v0.154.0','1c4cdc3b87ba290b5d110425b4f6ff21663e236580bc760d1e149bd2d9f9519f'),
        ('codex-package_SHA256SUMS','https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-package_SHA256SUMS','c6efb14f673ecb83d0196b5f4e0cdefbfe4f732c0d5a28cbc4eeb159c001b272'),
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(lambda j:fetch(*j),jobs))
    sums=(INPUT/'codex-package_SHA256SUMS').read_text('utf-8')
    if '94cc5b3632769504c809f6c0364b693c0dfddc5c30c8361095d2263a07ac45a4  codex-package-x86_64-pc-windows-msvc.tar.gz' not in sums:
        raise ValueError('Official checksum list mismatch')
    (INPUT/'input-manifest.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    with tarfile.open(INPUT/jobs[0][0]) as archive:
        files=[];seen=set()
        for item in archive:
            if item.isdir():continue
            if not item.isfile() or any(p in ('','.','..') or ':' in p or '\\' in p for p in item.name.split('/')) or item.name.lower() in seen:
                raise ValueError('Unsafe upstream member')
            seen.add(item.name.lower())
            data=archive.extractfile(item).read()
            output=RUNTIME/item.name;output.parent.mkdir(parents=True,exist_ok=True);output.write_bytes(data)
            files.append(dict(path=item.name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
        (NEW/'upstream-payload-inventory.json').write_text(json.dumps(files,indent=2)+'\n',encoding='utf-8')
    with tarfile.open(INPUT/jobs[1][0]) as archive:
        for name in ['LICENSE','NOTICE']:
            target=RUNTIME/'licenses'/name;target.parent.mkdir(exist_ok=True);target.write_bytes(archive.extractfile('codex-rust-v0.154.0/'+name).read())
    shutil.copyfile(INPUT/jobs[1][0],PUBLIC/jobs[1][0])
    metadata=json.loads((RUNTIME/'codex-package.json').read_text('utf-8'))
    if metadata['version']!=VERSION or metadata['entrypoint']!='bin/codex.exe':raise ValueError('Package metadata mismatch')
    print(json.dumps(dict(staged=True,files=len(files),bytes=sum(f['bytes'] for f in files))),flush=True)

def sources():
    spec=importlib.util.spec_from_file_location('upstream_source_builder',REPO/'scripts/prepare-optional-component-sources.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.REPO=NEW;module.CACHE=NEW/'source-cache';module.CACHE.mkdir(exist_ok=True)
    main=INPUT/'codex-0.154.0-source.tar.gz'
    if hashlib.sha256(main.read_bytes()).hexdigest()!='1c4cdc3b87ba290b5d110425b4f6ff21663e236580bc760d1e149bd2d9f9519f':raise ValueError('Main source checksum mismatch')
    with tarfile.open(main) as archive:
        lock=tomllib.loads(archive.extractfile('codex-rust-v0.154.0/codex-rs/Cargo.lock').read().decode())
    rg_source=fetch('ripgrep-15.2.0-source.tar.gz','https://codeload.github.com/BurntSushi/ripgrep/tar.gz/refs/tags/15.2.0','7605249d3eb0d5f170e3414498e3344e26b1e7a147aec518b57090b80036a562')
    with tarfile.open(INPUT/rg_source['name']) as archive:
        rg_lock=tomllib.loads(archive.extractfile('ripgrep-15.2.0/Cargo.lock').read().decode())
    jobs={}
    for package in lock['package']+rg_lock['package']:
        origin=package.get('source','');name,version=package['name'],package['version']
        if origin.startswith('registry+'):
            filename='crates/'+name+'-'+version+'.crate';jobs[filename]=(filename,'https://static.crates.io/crates/'+name+'/'+name+'-'+version+'.crate',package['checksum'])
        elif origin.startswith('git+https://github.com/'):
            repo,revision=origin.removeprefix('git+https://github.com/').split('#');repo=repo.split('?')[0].removesuffix('.git')
            filename='git/'+repo.replace('/','-')+'-'+revision+'.tar.gz';jobs[filename]=(filename,'https://codeload.github.com/'+repo+'/tar.gz/'+revision,None)
        elif origin:raise ValueError('Unsupported source origin')
    rg_name=rg_source['name'];shutil.copyfile(INPUT/rg_name,module.CACHE/rg_name)
    jobs[rg_name]=(rg_name,rg_source['url'],rg_source['sha256'])
    reused=0
    for name,url,expected in jobs.values():
        cached=SOURCES/name;dest=module.CACHE/name
        if cached.is_file() and not dest.exists():
            if expected and hashlib.sha256(cached.read_bytes()).hexdigest()!=expected:raise ValueError('Old cached crate mismatch')
            dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cached,dest);reused+=1
    missing=sum(not (module.CACHE/name).is_file() for name in jobs)
    print(json.dumps(dict(sourceCount=len(jobs),reusedCache=reused,downloadsRequired=missing)),flush=True)
    (NEW/'source-plan.json').write_text(json.dumps(dict(count=len(jobs),reused=reused,inputs=list(jobs.values())),indent=2)+'\n',encoding='utf-8')
    module.bundle('codex-cli',VERSION,list(jobs.values()),main)
    helper_notices()

def helper_notices():
    # Verify the helper matches the known upstream ripgrep distribution before reusing its licenses.
    fetch('ripgrep-15.2.0-windows.zip','https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip','71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5')
    old_zip=INPUT/'ripgrep-15.2.0-windows.zip'
    with zipfile.ZipFile(old_zip) as archive:
        prefix='ripgrep-15.2.0-x86_64-pc-windows-msvc/'
        if archive.read(prefix+'rg.exe')!=(RUNTIME/'codex-path/rg.exe').read_bytes():raise ValueError('New ripgrep needs independent source/license review')
        for name in ['COPYING','LICENSE-MIT','UNLICENSE']:(RUNTIME/'licenses'/('ripgrep-'+name)).write_bytes(archive.read(prefix+name))
    notices=[RUNTIME/'licenses'/name for name in ['THIRD_PARTY_LICENSES.txt','ripgrep-COPYING','ripgrep-LICENSE-MIT','ripgrep-UNLICENSE']]
    (PUBLIC/'THIRD_PARTY_LICENSES.txt').write_bytes(b'\n\n'.join(p.read_bytes() for p in notices))

{'inputs':inputs,'sources':sources,'notices':helper_notices}[sys.argv[1]]()
