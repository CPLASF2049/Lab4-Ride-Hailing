"""Package source and real evidence; exclude credentials, live databases, and Git internals."""
import hashlib
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
output = root.parent / 'lab3-rideshare-submit.zip'
skip = {'.git', '.runtime', 'data', 'node_modules', '__pycache__'}
files = [p for p in root.rglob('*') if p.is_file() and not any(part in skip for part in p.relative_to(root).parts) and p.name != '.env' and p.suffix != '.pyc' and '.sqlite' not in p.name]
with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(files):
        archive.write(file, Path('lab3-rideshare') / file.relative_to(root))
with ZipFile(output) as archive:
    bad = archive.testzip()
    if bad:
        raise RuntimeError('Invalid ZIP member: ' + bad)
    names = archive.namelist()
    assert 'lab3-rideshare/docs/report.md' in names
    assert 'lab3-rideshare/docs/architecture.png' in names
    assert 'lab3-rideshare/docs/evidence/tests.tap' in names
    assert not any('/.env' == '/' + Path(n).name or '/.runtime/' in n or '/.git/' in n or '.sqlite' in n for n in names)
print(f'PASS: {len(files)} files; {output.stat().st_size} bytes; archive integrity checked.')
print(output)
print('SHA256=' + hashlib.sha256(output.read_bytes()).hexdigest())
