#!/usr/bin/env python3
"""
올케어 과학 주간테스트 등록기

선생님이 보내 주신 주간테스트 파일(.hwp / .pdf)에서
  · 문항 수, 정답(①~⑤), 발문·해설 글자
  · 문항별 그림 파일(q01.png …)과 해설 그림 파일(e01.png …)
을 뽑아 test.json 과 함께 한 폴더에 저장합니다.

  python3 register_test.py --id 고1-1018 --grade 고1 --date 2026-10-18 \
      --hwp "주간테스트(고1).hwp" --pdf "주간테스트(고1).pdf" --out out/고1-1018

정답은 두 군데서 읽습니다.
  · HWP : [정답] 뒤의 동그라미 숫자 그림(①~⑤)을 템플릿과 비교
  · PDF : 정답 쪽의 'N) [정답]' 바로 뒤 그림을 같은 템플릿과 비교
둘 다 있으면 서로 대조하고, 하나라도 다르면 멈춥니다(돈·성적이 걸린 일이므로 추측하지 않음).
"""
import argparse, io, json, os, re, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
TPL = {d: np.asarray(Image.open(os.path.join(HERE, 'tpl', f'{d}.png')).convert('L').resize((40, 40)), dtype=float)
       for d in range(1, 6)}
ZOOM = 2.6          # PDF → 그림 해상도 (약 190dpi)


def classify_digit(img):
    """동그라미 숫자 그림 → (숫자, 차이값)"""
    im = np.asarray(img.convert('L').resize((40, 40)), dtype=float)
    best = (None, 9e9)
    for d, t in TPL.items():
        diff = float(np.abs(im - t).mean())
        if diff < best[1]:
            best = (d, diff)
    return best


# ───────────────────────── PDF ─────────────────────────
def pdf_layout(path):
    import pymupdf
    doc = pymupdf.open(path)
    W = doc[0].rect.width
    mid = W / 2
    qs, ans_anchor = [], []
    ans_page = None
    for pno, page in enumerate(doc):
        text = page.get_text('text')
        if ans_page is None and '정답 및 해설' in text:
            ans_page = pno
        lines = []
        for b in page.get_text('dict')['blocks']:
            for l in b.get('lines', []):
                t = ''.join(s['text'] for s in l['spans']).strip()
                lines.append((l['bbox'], t))
        foot = min([bb[1] for bb, t in lines if t.startswith('올케어에듀학원')] or [page.rect.height - 60])
        zbs = [bb for bb, t in lines if t.startswith('zb')]
        for bb, t in lines:
            col = 0 if bb[0] < mid else 1
            if ans_page is None or pno < ans_page:
                m = re.match(r'^(\d{1,2})\.$', t) or re.match(r'^(\d{1,2})\.\s', t)
                if m and bb[0] - (40 if col == 0 else mid) < 40:
                    qs.append(dict(no=int(m.group(1)), page=pno, col=col, y=bb[1], foot=foot, zbs=zbs))
            else:
                m = re.match(r'^(\d{1,2})\)\s*\[정답\]', t)
                if m:
                    ans_anchor.append(dict(no=int(m.group(1)), page=pno, col=col, y=bb[1], x1=bb[2], foot=foot, zbs=zbs))
    return doc, qs, ans_anchor, ans_page


def _segments(anchors, doc, top_default):
    """같은 단(page,col) 안에서 다음 앵커 전까지를 한 문항 영역으로. 단 머리의 이어짐은 앞 문항에 붙인다."""
    mid = doc[0].rect.width / 2
    W = doc[0].rect.width
    out = {}
    order = sorted(anchors, key=lambda a: (a['page'], a['col'], a['y']))
    cols = {}
    for a in order:
        cols.setdefault((a['page'], a['col']), []).append(a)
    prev_no = None
    for key in sorted(cols):
        page, col = key
        items = cols[key]
        x0 = 48 if col == 0 else mid + 4
        x1 = mid - 4 if col == 0 else W - 48
        top = top_default(page)
        if prev_no is not None and items[0]['y'] - top > 40:
            out.setdefault(prev_no, []).append((page, (x0, top, x1, items[0]['y'] - 6)))
        for i, a in enumerate(items):
            y1 = items[i + 1]['y'] - 6 if i + 1 < len(items) else a['foot'] - 4
            out.setdefault(a['no'], []).append((page, (x0, a['y'] - 6, x1, y1)))
            prev_no = a['no']
    return out


def _render(doc, segs, mask_zb=True):
    import pymupdf
    ims = []
    for page, (x0, y0, x1, y1) in segs:
        p = doc[page]
        clip = pymupdf.Rect(x0, y0, x1, y1)
        pix = p.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip, alpha=False)
        im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        ims.append(_trim(im))
    ims = [i for i in ims if i is not None]
    if not ims:
        return None
    w = max(i.width for i in ims)
    h = sum(i.height for i in ims) + 12 * (len(ims) - 1)
    canvas = Image.new('RGB', (w, h), 'white')
    y = 0
    for i in ims:
        canvas.paste(i, (0, y)); y += i.height + 12
    return canvas


def _trim(im, pad=10):
    a = np.asarray(im.convert('L'))
    rows = np.where((a < 235).sum(axis=1) > 0)[0]
    cols = np.where((a < 235).sum(axis=0) > 0)[0]
    if not len(rows):
        return None
    y0, y1 = max(0, rows[0] - pad), min(a.shape[0], rows[-1] + pad)
    x0, x1 = max(0, cols[0] - pad), min(a.shape[1], cols[-1] + pad)
    return im.crop((0, y0, im.width, y1))  # 가로는 단 폭 유지(글자 크기 통일)


def _mask_zb(doc):
    """문항 번호 옆에 깔린 'zb N)' 표시(출처 꼬리표)를 하얗게 덮는다."""
    import pymupdf
    for page in doc:
        for b in page.get_text('dict')['blocks']:
            for l in b.get('lines', []):
                for s in l['spans']:
                    if s['text'].strip().startswith('zb'):
                        r = pymupdf.Rect(s['bbox'])
                        # 'zb' 와 번호 부분만 (뒤 발문은 남김)
                        m = re.match(r'^\s*zb\s*\d+\s*\)', s['text'])
                        if m and len(s['text'].strip()) > len(m.group(0)) + 1:
                            frac = len(m.group(0)) / max(1, len(s['text']))
                            r.x1 = r.x0 + (r.x1 - r.x0) * frac
                        page.add_redact_annot(r, fill=(1, 1, 1))
        page.apply_redactions(images=0, graphics=0)


def pdf_answers(doc, ans_anchor):
    """정답 쪽 'N) [정답]' 바로 오른쪽 그림 → 숫자"""
    import pymupdf
    res = {}
    infos = {}
    for a in ans_anchor:
        p = doc[a['page']]
        if a['page'] not in infos:
            infos[a['page']] = p.get_image_info(xrefs=True)
        cand = [i for i in infos[a['page']]
                if abs(i['bbox'][1] - a['y']) < 6 and 0 <= i['bbox'][0] - a['x1'] < 30 and (i['bbox'][2] - i['bbox'][0]) < 20]
        digits = []
        for i in sorted(cand, key=lambda i: i['bbox'][0]):
            r = pymupdf.Rect(i['bbox'])
            pix = p.get_pixmap(matrix=pymupdf.Matrix(8, 8), clip=r, alpha=False)
            im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            d, diff = classify_digit(im)
            if d and diff < 60:
                digits.append(d)
        res[a['no']] = sorted(set(digits))
    return res


# ───────────────────────── 메인 ─────────────────────────
def build(args):
    os.makedirs(args.out, exist_ok=True)
    hq = None
    if args.hwp:
        from hwpquiz import parse
        hq, _ = parse(args.hwp)
    n_h = len(hq) if hq else None

    pdf_info = None
    if args.pdf:
        import pymupdf
        doc, qa, aa, ans_page = pdf_layout(args.pdf)
        pa = pdf_answers(doc, aa)
        _mask_zb(doc)
        hdr_top = lambda page: 108 if page == 0 else 66
        qsegs = _segments(qa, doc, hdr_top)
        asegs = _segments(aa, doc, lambda page: 66) if aa else {}
        pdf_info = dict(n=len(qa), ans=pa)
        for no, segs in qsegs.items():
            im = _render(doc, segs)
            if im: _save(im, os.path.join(args.out, f'q{no:02d}.png'))
        for no, segs in asegs.items():
            im = _render(doc, segs)
            if im: _save(im, os.path.join(args.out, f'e{no:02d}.png'))

    if hq and not args.pdf:
        # PDF가 없으면 HWP 화면에서 문항 그림을 만든다(수식이 빠질 수 있음)
        from hwp_render import render_questions
        marked = [i for i, q in enumerate(hq) if not q.get('nozb')]
        ims = render_questions(args.hwp, args.out, n_expected=len(marked))
        last = None
        for i, q in enumerate(hq):
            if not q.get('nozb'):
                last = ims[marked.index(i)]
            # 'zb' 표시가 빠진 문항은 앞 문항과 한 그림에 들어 있음 → 같은 그림을 쓴다
            _save(last, os.path.join(args.out, f'q{i + 1:02d}.png'))

    n = n_h or (pdf_info and pdf_info['n'])
    if not n:
        sys.exit('문항을 찾지 못했습니다.')
    if hq and pdf_info and pdf_info['n'] != n_h:
        sys.exit(f'문항 수 불일치: HWP {n_h} / PDF {pdf_info["n"]}')

    qs = []
    problems = []
    for i in range(n):
        no = i + 1
        a_h = hq[i]['ans'] if hq else None
        a_p = pdf_info['ans'].get(no) if pdf_info else None
        if a_h and a_p and a_h != a_p:
            problems.append(f'{no}번 정답 불일치 HWP{a_h} PDF{a_p}')
        ans = a_h or a_p
        if not ans:
            problems.append(f'{no}번 정답을 찾지 못함')
        q = dict(no=no, ans=ans or [],
                 stem=' '.join(hq[i]['stem']).strip() if hq else '',
                 body=' / '.join(hq[i]['after'])[:600] if hq else '',
                 exp=hq[i]['exp'] if hq else '',
                 img=f'q{no:02d}.png' if os.path.exists(os.path.join(args.out, f'q{no:02d}.png')) else '',
                 eimg=f'e{no:02d}.png' if os.path.exists(os.path.join(args.out, f'e{no:02d}.png')) else '',
                 unit='', concept='')
        qs.append(q)
    if problems:
        sys.exit('등록 중단:\n  ' + '\n  '.join(problems))

    test = dict(id=args.id, grade=args.grade, date=args.date, title=args.title or f'{args.date[5:].replace("-", "")} 주간테스트',
                n=n, source=dict(hwp=os.path.basename(args.hwp or ''), pdf=os.path.basename(args.pdf or '')),
                questions=qs)
    with open(os.path.join(args.out, 'test.json'), 'w', encoding='utf-8') as f:
        json.dump(test, f, ensure_ascii=False, indent=1)
    print(f'{args.id}: {n}문항 · 정답 {"".join(str(q["ans"][0]) if len(q["ans"]) == 1 else "(" + "".join(map(str, q["ans"])) + ")" for q in qs)}')
    print(f'  문항그림 {sum(1 for q in qs if q["img"])} · 해설그림 {sum(1 for q in qs if q["eimg"])}')


def _save(im, path):
    im = im.convert('RGB')
    q = im.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
    q.save(path, optimize=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True)
    ap.add_argument('--grade', required=True)
    ap.add_argument('--date', required=True, help='수업일(시험지 배부일) YYYY-MM-DD')
    ap.add_argument('--title')
    ap.add_argument('--hwp')
    ap.add_argument('--pdf')
    ap.add_argument('--out', required=True)
    build(ap.parse_args())
