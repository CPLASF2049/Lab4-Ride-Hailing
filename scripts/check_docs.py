"""Check repository Markdown links and Python syntax without optional dependencies."""
import ast
import re
import unicodedata
from pathlib import Path
from urllib.parse import unquote

root = Path(__file__).resolve().parents[1]
errors = []
count = 0

def slug(text):
    text = re.sub(r'[`*_]', '', text).lower().strip()
    return ''.join(c for c in text if not unicodedata.category(c).startswith('P') or c in '-_').replace(' ', '-')

for source in [root / 'README.md', root / 'lab4-report.md', *sorted((root / 'docs').glob('*.md')), *sorted((root / 'contracts').glob('*.md'))]:
    text = source.read_text(encoding='utf-8-sig')
    for link in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        link = link.strip().strip('<>')
        if link.startswith(('https://', 'http://', 'mailto:')):
            continue
        target, _, anchor = unquote(link).partition('#')
        file = (source.parent / target).resolve() if target else source
        if not file.is_file():
            errors.append(f'{source.relative_to(root)}: missing {link}')
        elif anchor and file.suffix == '.md':
            headings = re.findall(r'^#{1,6}\s+(.+)$', file.read_text(encoding='utf-8-sig'), re.M)
            if anchor not in {slug(h) for h in headings}:
                errors.append(f'{source.relative_to(root)}: missing heading {link}')
        count += 1
for source in (root / 'scripts').glob('*.py'):
    ast.parse(source.read_text(encoding='utf-8-sig'), filename=str(source))
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {count} local Markdown links and all Python scripts parse.')
