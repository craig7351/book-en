"""把 Tatoeba 中英對照例句寫進離線字典 src-tauri/resources/ecdict.db（M10 單字卡例句）。

資料：Tatoeba（https://tatoeba.org），CC BY 2.0 FR → App 設定的「貢獻」分頁標註出處。
- 只取有中文翻譯、4–20 個字的英文句；中文用 OpenCC 轉台灣繁體
- 每句斷詞 → 原形（沿用 build-freq.py 寫入的 freq 表與 ECDICT 詞形）→ 倒排索引
- 難度 = 句中「目標字以外」最難字的排名 → 先給其他字都簡單的句子（一句只學一個新字）
- 每個原形最多留 30 句

產生：
  examples(id, en, zh)
  example_index(lemma, id, difficulty, len)

用法（先跑 build-ecdict.mjs 與 build-freq.py）：
  .cache/venv/Scripts/python -m pip install opencc-python-reimplemented
  .cache/venv/Scripts/python tools/build-examples.py
"""

import bz2
import csv
import re
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

import opencc

DB = "src-tauri/resources/ecdict.db"
CACHE = Path(".cache/tatoeba")
BASE = "https://downloads.tatoeba.org/exports/per_language"
FILES = {
    "eng": f"{BASE}/eng/eng_sentences.tsv.bz2",
    "cmn": f"{BASE}/cmn/cmn_sentences.tsv.bz2",
    "links": f"{BASE}/eng/eng-cmn_links.tsv.bz2",
}
MIN_WORDS, MAX_WORDS, PER_LEMMA = 4, 20, 30
UNKNOWN_RANK = 30000  # 沒排名的小寫字當成難字
TOKEN_RE = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
# 中文字、全形標點之間多餘的空白（「之後， 我」）
CJK_GAP = re.compile(r"([　-〿㐀-鿿＀-￯])\s+(?=[　-〿㐀-鿿＀-￯])")

csv.field_size_limit(sys.maxsize)


def fetch(name: str, url: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"下載 {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "book-en build script"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            f.write(r.read())
    return path


def rows(path: Path):
    with bz2.open(path, "rt", encoding="utf-8") as f:
        yield from csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)


paths = {k: fetch(k, u) for k, u in FILES.items()}
eng = {r[0]: r[2] for r in rows(paths["eng"]) if len(r) >= 3}
cmn = {r[0]: r[2] for r in rows(paths["cmn"]) if len(r) >= 3}
zh_of = {}
for r in rows(paths["links"]):
    if len(r) >= 2 and r[0] in eng and r[1] in cmn:
        # 一句英文可能有多個中文翻譯：取最短的（通常最貼近）
        z = cmn[r[1]]
        if r[0] not in zh_of or len(z) < len(zh_of[r[0]]):
            zh_of[r[0]] = z
print(f"英文 {len(eng)} 句，有中文翻譯的 {len(zh_of)} 句")

db = sqlite3.connect(DB)
lemma_of = dict(db.execute("SELECT word, lemma FROM freq"))
for word, exchange in db.execute("SELECT word, exchange FROM dict WHERE exchange LIKE '%0:%'"):
    w = word.lower()
    if w not in lemma_of:
        for part in exchange.split("/"):
            if part.startswith("0:"):
                lemma_of[w] = part[2:].strip().lower()
                break
rank_of = dict(db.execute("SELECT lemma, rank FROM lemma_rank"))
to_tw = opencc.OpenCC("s2twp")

seen_en = set()
examples = []  # (id, en, zh)
index = defaultdict(list)  # lemma -> [(difficulty, len, id)]
for eid, en in eng.items():
    zh = zh_of.get(eid)
    if not zh:
        continue
    en = en.strip()
    if en in seen_en:
        continue
    tokens = TOKEN_RE.findall(en)
    if not (MIN_WORDS <= len(tokens) <= MAX_WORDS):
        continue
    seen_en.add(en)
    sid = len(examples) + 1
    examples.append((sid, en, CJK_GAP.sub(r"\1", to_tw.convert(zh.strip()))))

    # 每個字：原形與難度（人名等大寫且沒排名的字當成簡單）
    parsed = []
    for i, tok in enumerate(tokens):
        w = tok.lower().replace("’", "'")
        lemma = lemma_of.get(w, w)
        rank = rank_of.get(lemma)
        if rank is None:
            rank = 0 if (tok[0].isupper() and i > 0) else UNKNOWN_RANK
        parsed.append((lemma, rank))
    for lemma in {l for l, _ in parsed if l in rank_of}:
        difficulty = max((r for l, r in parsed if l != lemma), default=0)
        index[lemma].append((difficulty, len(tokens), sid))

db.executescript(
    """
    DROP TABLE IF EXISTS examples;
    DROP TABLE IF EXISTS example_index;
    CREATE TABLE examples(id INTEGER PRIMARY KEY, en TEXT NOT NULL, zh TEXT);
    CREATE TABLE example_index(lemma TEXT NOT NULL, id INTEGER NOT NULL, difficulty INTEGER NOT NULL, len INTEGER NOT NULL);
    """
)
kept = set()
idx_rows = []
for lemma, lst in index.items():
    for difficulty, n, sid in sorted(lst)[:PER_LEMMA]:
        idx_rows.append((lemma, sid, difficulty, n))
        kept.add(sid)
db.executemany("INSERT INTO examples VALUES (?, ?, ?)", [e for e in examples if e[0] in kept])
db.executemany("INSERT INTO example_index VALUES (?, ?, ?, ?)", idx_rows)
db.execute("CREATE INDEX example_index_lemma ON example_index(lemma, difficulty, len)")
db.execute("INSERT OR REPLACE INTO meta VALUES ('tatoeba_examples', ?)", (str(len(kept)),))
db.commit()
db.execute("VACUUM")
db.close()
print(f"例句 {len(kept)} 句，涵蓋 {len(index)} 個原形，索引 {len(idx_rows)} 筆 → {DB}")
