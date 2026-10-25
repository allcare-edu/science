"""PDF가 없을 때: HWP → (pyhwp) XHTML → Chromium 화면 → 문항별 그림.
pyhwp 소스가 필요합니다. 없으면 PyPI에서 sdist를 받아 /tmp/pyhwp 에 풀어 씁니다.
※ pyhwp의 HTML 변환은 수식(한글 수식 편집기)을 빼먹습니다. 가능하면 PDF를 함께 받으세요."""
import os, subprocess, sys, glob, tarfile, shutil, asyncio, io
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
import numpy as np

def _pyhwp_src():
    cand = glob.glob('/tmp/pyhwp/pyhwp-*/src')
    if cand: return cand[0]
    os.makedirs('/tmp/pyhwp', exist_ok=True)
    subprocess.run([sys.executable, '-m', 'pip', 'download', '--no-deps', '--no-binary', ':all:', 'pyhwp', '-d', '/tmp/pyhwp'],
                   check=True, capture_output=True)
    tgz = glob.glob('/tmp/pyhwp/pyhwp-*.tar.gz')[0]
    with tarfile.open(tgz) as t: t.extractall('/tmp/pyhwp')
    return glob.glob('/tmp/pyhwp/pyhwp-*/src')[0]

def hwp_to_xhtml(hwp, outdir):
    src = _pyhwp_src()
    if os.path.exists(outdir): shutil.rmtree(outdir)
    code = "import sys; sys.argv=['hwp5html','--output',%r,%r]; from hwp5.hwp5html import main; main()" % (outdir, hwp)
    subprocess.run([sys.executable, '-c', code], env=dict(os.environ, PYTHONPATH=src), check=True, capture_output=True, timeout=300)
    return os.path.join(outdir, 'index.xhtml')

async def _shots(xhtml):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 820, 'height': 1200}, device_scale_factor=1.6)
        await pg.goto('file://' + xhtml)
        await pg.wait_for_timeout(600)
        tops = await pg.evaluate("""() => {
          const zs=[...document.querySelectorAll('span')].filter(s=>s.textContent.trim()==='zb');
          zs.forEach(s=>s.style.visibility='hidden');
          const tops=zs.map(s=>{const p=s.closest('p')||s; return p.getBoundingClientRect().top+window.scrollY;});
          // 본문 끝: 마지막 보이는 요소 아래
          let end=0; document.querySelectorAll('p,img,table').forEach(e=>{const r=e.getBoundingClientRect(); if(r.height>0&&e.textContent.trim()!=='') end=Math.max(end,r.bottom+window.scrollY);});
          document.querySelectorAll('img').forEach(e=>{const r=e.getBoundingClientRect(); end=Math.max(end,r.bottom+window.scrollY);});
          const ps=[...document.querySelectorAll('p')].filter(p=>p.textContent.trim()!=='');
          const ansHead=ps.find(p=>/정답 및 해설/.test(p.textContent));
          if(ansHead) end=Math.min(end, ansHead.getBoundingClientRect().top+window.scrollY-6);
          const body=ps.filter(p=>!ansHead||p.getBoundingClientRect().top<ansHead.getBoundingClientRect().top);
          const x0=Math.min(...body.map(p=>p.getBoundingClientRect().left));
          const x1=Math.max(...body.map(p=>{let r=p.getBoundingClientRect().left; p.querySelectorAll('span,img').forEach(c=>{r=Math.max(r,c.getBoundingClientRect().right)}); return r;}));
          return {tops, end, x0, x1};
        }""")
        png = await pg.screenshot(full_page=True)
        await b.close()
    return tops, png

def render_questions(hwp, outdir, n_expected=None, scale=1.6):
    xhtml = hwp_to_xhtml(hwp, os.path.join(outdir, '_xhtml'))
    info, png = asyncio.run(_shots(xhtml))
    full = Image.open(io.BytesIO(png)).convert('RGB')
    tops = info['tops']; end = info['end']
    if n_expected and len(tops) != n_expected:
        raise SystemExit(f'HWP 화면 문항 수 {len(tops)} ≠ {n_expected} (zb 표시 누락) — PDF를 받아 주세요')
    out = []
    X0 = int(max(0, info['x0'] - 12) * scale); X1 = int(min(full.width / scale, info['x1'] + 12) * scale)
    for i, t in enumerate(tops):
        y0 = int((t - 10) * scale)
        y1 = int(((tops[i + 1] - 10) if i + 1 < len(tops) else end) * scale)
        im = full.crop((X0, max(0, y0), X1, min(full.height, y1)))
        a = np.asarray(im.convert('L')); rows = np.where((a < 235).sum(axis=1) > 0)[0]
        if len(rows): im = im.crop((0, max(0, rows[0] - 8), im.width, min(im.height, rows[-1] + 10)))
        out.append(im)
    shutil.rmtree(os.path.join(outdir, '_xhtml'), ignore_errors=True)
    return out
