"""Independent placement check: every markdown table cell must appear in the
rendered page under its own column heading, in its own row's card, in order.
Independent of build.mjs (Python, real HTML parser, no shared code)."""
import re, sys, html
from html.parser import HTMLParser

md = open("tracker.md", encoding="utf-8").read()
page = open("docs/index.html", encoding="utf-8").read()

def md_plain(s):
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", s)   # links -> text
    s = re.sub(r"(?<!\\)\*\*|(?<!\\)\*", "", s)                # emphasis markers (not escaped ones)
    s = re.sub(r"\\(.)", r"\1", s)                               # author's escapes
    return re.sub(r"\s+", " ", s).strip()

def md_links(s):
    return [(md_plain(t), u) for t, u in re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", s)]

# --- parse markdown tables and paragraphs ---
tables, paras = [], []
lines = md.split("\n"); i = 0
while i < len(lines):
    l = lines[i]
    if l.startswith("|") and i + 1 < len(lines) and re.fullmatch(r"\|( --- \|)+", lines[i+1].strip()):
        split = lambda row: [c.strip() for c in row.strip().strip("|").split(" | ")]
        heads = split(l); rows = []; i += 2
        while i < len(lines) and lines[i].startswith("|"):
            rows.append(split(lines[i])); i += 1
        assert all(len(r) == len(heads) for r in rows), "ragged table"
        tables.append((heads, rows)); continue
    if l.strip() and not l.startswith("#") and not l.startswith("|"):
        paras.append(re.sub(r"^\s*[-*]\s+", "", l).strip())   # drop list-bullet syntax
    i += 1

# --- parse HTML into cards / pairs / matrices ---
class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True)
        s.stack=[]; s.cards=[]; s.pairs=[]; s.matrices=[]; s.cur=None; s.buf=None; s.text_all=[]
        s.links=[]; s.href=None
    def handle_starttag(s, tag, attrs):
        a=dict(attrs); cls=a.get("class","")
        s.stack.append((tag, cls))
        if tag=="article" and "record" in cls: s.cur={"kind":"card","title":"","state":None,"fields":[],"id":a.get("id")}; s.cards.append(s.cur)
        if tag=="div" and cls=="pair": s.cur={"kind":"pair","title":"","fields":[],"id":a.get("id")}; s.pairs.append(s.cur)
        if tag=="div" and cls=="matrix": s.cur={"kind":"matrix","rows":[],"head":[]}; s.matrices.append(s.cur)
        if tag=="tr" and s.cur and s.cur["kind"]=="matrix": s.cur["rows"].append([])
        if s.cur and tag in ("h3","dt","dd","th","td","span") and (tag!="span" or "chip" in cls):
            if tag=="span" and "chip" in cls: s.buf=("state",[],[])
            elif tag=="h3" and "title" in cls: s.buf=("title",[],[])
            elif tag in ("dt","dd","th","td"): s.buf=(tag,[],[])
        if tag=="a" and s.buf is not None: s.href=a.get("href"); s.atext=[]
    def handle_endtag(s, tag):
        if tag=="a" and s.buf is not None and s.href:
            s.buf[2].append((re.sub(r"\s+"," ","".join(s.atext)).strip(), s.href)); s.href=None
        if s.buf and tag==s.buf[0] or (s.buf and s.buf[0]=="title" and tag=="h3") or (s.buf and s.buf[0]=="state" and tag=="span" and s.stack and s.stack[-1][1].startswith("chip")):
            kind, chunks, links = s.buf; txt=re.sub(r"\s+"," ","".join(chunks)).strip()
            if kind=="title": s.cur["title"]=(txt,links)
            elif kind=="state": s.cur["state"]=(txt,links)
            elif kind in ("dt","dd"): s.cur["fields"].append((kind,txt,links))
            elif kind in ("th","td") and s.cur["kind"]=="matrix": s.cur["rows"][-1].append((txt,links)) if s.cur["rows"] else None
            s.buf=None
        if tag in ("article","div","section") and s.cur and s.stack and s.stack[-1][0]==tag:
            if (tag=="article") or (tag=="div" and s.stack[-1][1] in ("pair","matrix")): s.cur=None
        if s.stack: s.stack.pop()
    def handle_data(s, d):
        s.text_all.append(d)
        if s.buf is not None:
            s.buf[1].append(d)
            if s.href is not None: s.atext.append(d)
p=P(); p.feed(page)
page_text=re.sub(r"\s+"," ","".join(p.text_all))

def vh_strip(txt, label):  # remove the visually-hidden "Label: " prefix
    return txt[len(label)+1:].strip() if txt.startswith(label+":") else txt

errors=[]; checked_cells=0; checked_links=0
ci=pi=mi=0
for heads, rows in tables:
    H=[md_plain(h) for h in heads]
    if H[0] in ("Dimension","Jurisdiction / bill"):
        mtx=p.matrices[mi]; mi+=1
        body=[r for r in mtx["rows"][1:]]
        if len(body)!=len(rows): errors.append(f"matrix {H[0]}: {len(body)} rows vs {len(rows)}")
        for r, hr in zip(rows, body):
            for c, (txt,links) in zip(r, hr):
                checked_cells+=1
                if md_plain(c)!=txt: errors.append(f"matrix cell mismatch: {md_plain(c)[:60]!r} vs {txt[:60]!r}")
        continue
    if len(heads)==2:
        for r in rows:
            pr=p.pairs[pi]; pi+=1
            dts=[f for f in pr["fields"] if f[0]=="dt"]; dds=[f for f in pr["fields"] if f[0]=="dd"]
            t=vh_strip(dts[0][1],H[0]); d=dds[0][1]
            if not d.startswith(H[1]): errors.append(f"pair missing label {H[1]}")
            d=d[len(H[1]):].strip()
            checked_cells+=2
            if md_plain(r[0])!=t: errors.append(f"pair title: {md_plain(r[0])[:60]!r} vs {t[:60]!r}")
            if md_plain(r[1])!=d: errors.append(f"pair body: {md_plain(r[1])[:60]!r} vs {d[:60]!r}")
            for L in md_links(r[1]):
                checked_links+=1
                if L not in dds[0][2]: errors.append(f"pair link missing {L}")
        continue
    sidx=H.index("State") if "State" in H else -1
    for r in rows:
        card=p.cards[ci]; ci+=1
        title=vh_strip(card["title"][0],H[0])
        checked_cells+=1
        if md_plain(r[0])!=title: errors.append(f"title: {md_plain(r[0])[:70]!r} vs {title[:70]!r}")
        for L in md_links(r[0]):
            checked_links+=1
            if L not in card["title"][1]: errors.append(f"title link missing {L}")
        if sidx>=0:
            checked_cells+=1
            st=vh_strip(card["state"][0],"State") if card["state"] else None
            if md_plain(r[sidx])!=st: errors.append(f"state: {r[sidx]!r} vs {st!r}")
        fields=card["fields"]; pairs=[(fields[k][1],fields[k+1][1],fields[k+1][2]) for k in range(0,len(fields),2)]
        expected=[(H[k],md_plain(r[k]),md_links(r[k])) for k in range(len(r)) if k!=0 and k!=sidx]
        if len(pairs)!=len(expected): errors.append(f"{title[:50]}: {len(pairs)} fields vs {len(expected)} columns")
        got={lab:(val,links) for lab,val,links in pairs}
        for lab,val,links in expected:
            checked_cells+=1
            if lab not in got: errors.append(f"{title[:50]}: column {lab!r} missing"); continue
            if got[lab][0]!=val: errors.append(f"{title[:50]} / {lab}: {val[:70]!r} vs {got[lab][0][:70]!r}")
            for L in links:
                checked_links+=1
                if L not in got[lab][1]: errors.append(f"{title[:50]} / {lab}: link missing {L}")
        # column order preserved (labels appear in the markdown's column order)
        order=[lab for lab,_,_ in pairs]; exp_order=[lab for lab,_,_ in expected]
        if order!=exp_order: errors.append(f"{title[:50]}: column order {order} vs {exp_order}")

# paragraphs outside tables
missing_paras=[q for q in paras if md_plain(q) not in page_text]
for q in missing_paras: errors.append(f"paragraph missing: {md_plain(q)[:80]!r}")

print(f"tables {len(tables)}  rows {sum(len(r) for _,r in tables)}  cards {len(p.cards)}  pairs {len(p.pairs)}  matrices {len(p.matrices)}")
print(f"cells checked under their own heading: {checked_cells}   links checked inside their own cell: {checked_links}   paragraphs checked: {len(paras)}")
print("ERRORS:", len(errors)); [print(" -", e) for e in errors[:40]]
sys.exit(1 if errors else 0)
