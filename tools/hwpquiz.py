"""HWP5 주간테스트 → 문항(번호·발문·선지·정답·해설·그림) 추출. 족보닷컴 양식 전용."""
import olefile, zlib, struct, io, os, re, json, sys
from PIL import Image, ImageChops
HERE=os.path.dirname(os.path.abspath(__file__))
TPL={d:Image.open(os.path.join(HERE,'tpl',f'{d}.png')).convert('L') for d in range(1,6)}

def _records(ole, comp):
    secs=sorted([s for s in ole.listdir() if s[0]=='BodyText'],key=lambda s:int(s[1][7:]))
    for s in secs:
        data=ole.openstream(s).read()
        if comp: data=zlib.decompress(data,-15)
        i=0
        while i<len(data):
            h=struct.unpack_from('<I',data,i)[0]; i+=4
            tag=h&0x3ff; lvl=(h>>10)&0x3ff; size=(h>>20)&0xfff
            if size==0xfff: size=struct.unpack_from('<I',data,i)[0]; i+=4
            yield tag,lvl,data[i:i+size]; i+=size

def _bins(ole):
    out={}
    for s in ole.listdir():
        if s[0]!='BinData': continue
        m=re.match(r'BIN([0-9A-F]{4})\.(\w+)',s[1])
        if not m: continue
        raw=ole.openstream(s).read()
        try: d=zlib.decompress(raw,-15)
        except Exception: d=raw
        out[int(m.group(1),16)]=(m.group(2).lower(),d)
    return out

def _digit(img_bytes):
    try: im=Image.open(io.BytesIO(img_bytes)).convert('L')
    except Exception: return None,9e9
    w,h=im.size
    if not (150<=w<=400 and abs(w-h)<=8): return None,9e9
    im=im.resize((40,40)); best=(None,9e9)
    for d,t in TPL.items():
        import numpy as np
        diff=float(np.abs(np.asarray(im,dtype=float)-np.asarray(t,dtype=float)).mean())
        if diff<best[1]: best=(d,diff)
    return best

def _para_text(rec, eqs):
    t=[]; j=0; ei=0
    while j<len(rec):
        c=struct.unpack_from('<H',rec,j)[0]
        if c<32:
            if c in (10,13): t.append('\n'); j+=2; continue
            if c==9: t.append(' '); j+=16; continue
            if c in (1,2,3,11,12,14,15,16,17,18,21,22,23):
                cid=rec[j+2:j+6][::-1].decode('latin1') if j+6<=len(rec) else ''
                if cid=='deqe' or cid=='eqed':
                    t.append('⟦EQ⟧')
                j+=16; continue
            if c in (4,5,6,7,8,19,20): j+=16; continue
            j+=2; continue
        t.append(chr(c)); j+=2
    return ''.join(t).encode('utf-16','surrogatepass').decode('utf-16','replace')

def _eq_clean(s):
    s=s.split('from')[0].replace('\r','').replace('\n',' ').strip()
    s=re.sub(r'\b(rm|RM|it|bold)\b',' ',s)
    s=re.sub(r'\b(rm|RM)(?=[A-Z0-9])','',s)
    s=re.sub(r'\{([^{}]*)\}\s*(over|OVER)\s*\{([^{}]*)\}',r'(\1)/(\3)',s)
    s=s.replace('`',' ').replace('~',' ').replace('{','').replace('}','')
    s=re.sub(r'\s*(SIMC|simc)\s*','',s)
    s=re.sub(r'\^(\w)',r'^\1',s)
    return re.sub(r'\s+',' ',s).strip()

def parse(path):
    ole=olefile.OleFileIO(path); comp=bool(ole.openstream('FileHeader').read()[36]&1)
    bins=_bins(ole); digit_cache={}
    def bin_digit(bid):
        if bid not in digit_cache:
            b=bins.get(bid); digit_cache[bid]=_digit(b[1]) if b else (None,9e9)
        return digit_cache[bid]
    recs=list(_records(ole,comp))
    # 1) 문단 텍스트 + 수식 + 그림을 순서대로 펼친다
    stream=[]  # ('t',text) ('eq',script) ('pic',binid)
    for tag,lvl,rec in recs:
        if tag==67: stream.append(('t',_para_text(rec,None)))
        elif tag==88:
            n=struct.unpack_from('<H',rec,4)[0]; stream.append(('eq',_eq_clean(rec[6:6+2*n].decode('utf-16le','replace'))))
        elif tag==85 and len(rec)>=73:
            stream.append(('pic',struct.unpack_from('<H',rec,71)[0]))
    # 수식 자리표시 채우기: 문단 안 ⟦EQ⟧ 순서 = 뒤따르는 eq 레코드 순서
    out=[]; pend=[]
    for kind,v in stream:
        if kind=='t':
            out.append(['t',v]); pend.extend([len(out)-1]*v.count('⟦EQ⟧'))
        elif kind=='eq':
            if pend:
                k=pend.pop(0); out[k][1]=out[k][1].replace('⟦EQ⟧',v if v else '□',1)
        else: out.append(['pic',v])
    for o in out:
        if o[0]=='t': o[1]=o[1].replace('⟦EQ⟧','□')
    # 2) 문항 나누기: 'zb' 로 시작하는 문단 = 새 문항.  순서: 발문 → [정답](그림) → [해설] → 보기·선지
    qs=[]; cur=None; mode='stem'
    for kind,v in out:
        if kind=='t':
            s=v.strip()
            if s.startswith('zb'):
                cur={'stem':[s[2:].strip()],'after':[],'ans':[],'exp':'','figs':[]}; qs.append(cur); mode='stem'; continue
            if cur is None: continue
            if s.startswith('[정답]'):
                if cur['exp'] or cur['ans']:
                    # 'zb' 표시가 빠진 문항: 앞 문항 뒤쪽에서 새 발문을 찾아 떼어 낸다
                    aft=cur['after']; cut=len(aft)
                    for k in range(len(aft)-1,-1,-1):
                        if re.search(r'(\?|것은|고르시오|쓰시오)\s*$',aft[k]) or re.match(r'^(그림|표|다음|그래프)',aft[k]):
                            cut=k
                            if re.match(r'^(그림|표|다음|그래프)',aft[k]): break
                    stem=aft[cut:]; cur['after']=aft[:cut]
                    cur={'stem':stem or ['(발문 추출 실패)'],'after':[],'ans':[],'exp':'','figs':[],'nozb':True}; qs.append(cur)
                mode='ans'; continue
            if s.startswith('[해설]'): cur['exp']=s[4:].strip(); mode='after'; continue
            if not s: continue
            if mode=='stem': cur['stem'].append(s)
            elif mode=='after': cur['after'].append(s)
        else:
            if cur is None: continue
            d,score=bin_digit(v)
            if d and score<40:
                if mode=='ans': cur['ans'].append(d)
                continue
            b=bins.get(v)
            if b:
                try:
                    w,h=Image.open(io.BytesIO(b[1])).size
                    if h>20 and w>40: cur['figs'].append(v)
                except Exception: pass
    for q in qs:
        q['ans']=sorted(set(q['ans']))
    return qs, bins

if __name__=='__main__':
    qs,_=parse(sys.argv[1])
    print(len(qs),'문항'); print(','.join('|'.join(map(str,q['ans'])) for q in qs))
