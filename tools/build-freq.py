"""把 wordfreq 的英文詞頻排名寫進離線字典 src-tauri/resources/ecdict.db。

wordfreq（https://github.com/rspeer/wordfreq）的資料來源含 OpenSubtitles 影視字幕，
比 ECDICT 內建的 COCA 書面語排名更貼近 YouTube 口語（yeah / okay / gonna）。
資料授權 CC BY-SA 4.0 → App 設定的「貢獻」分頁標註出處。

產生兩張表：
  freq(word, rank, lemma)   字面排名（1 = 最常用）與原形
  lemma_rank(lemma, rank)   原形家族排名 = 家族內最常用形式的排名（running / ran / runs → run）

用法（先執行 tools/build-ecdict.mjs 產生 ecdict.db）：
  python -m venv .cache/venv
  .cache/venv/Scripts/python -m pip install wordfreq
  .cache/venv/Scripts/python tools/build-freq.py
"""

import re
import sqlite3
from importlib.metadata import version

import wordfreq

DB = "src-tauri/resources/ecdict.db"
TOP_N = 60000
WORD_RE = re.compile(r"^[a-z][a-z'\-]*$")

db = sqlite3.connect(DB)

# ECDICT exchange 欄：0:原形（例如 running → 0:run）
lemma_of = {}
for word, exchange in db.execute("SELECT word, exchange FROM dict WHERE exchange LIKE '%0:%'"):
    for part in exchange.split("/"):
        if part.startswith("0:"):
            base = part[2:].strip().lower()
            if base and base != word.lower():
                lemma_of[word.lower()] = base
            break

# 人名：ECDICT 只有一個義項且標著（男子名）（女子名）（人名）（姓氏）→ 不分級（dennis、karen）。
# mark / bill / frank 這種有其他詞義的字照常分級；國名地名（holland）也照常分級。
NAME_RE = re.compile(r"（(男子名|女子名|人名|姓氏)")
translation_of = dict(db.execute("SELECT lower(word), translation FROM dict"))


def is_name(word: str) -> bool:
    t = (translation_of.get(word) or "").strip()
    return bool(t) and "\n" not in t and bool(NAME_RE.search(t))


top = [w for w in wordfreq.top_n_list("en", TOP_N) if WORD_RE.match(w)]
rows = []
family = {}
names = 0
for rank, word in enumerate(top, start=1):
    lemma = lemma_of.get(word, word)
    rows.append((word, rank, lemma))
    if is_name(lemma):
        names += 1
        continue
    if lemma not in family or rank < family[lemma]:
        family[lemma] = rank

db.executescript(
    """
    DROP TABLE IF EXISTS freq;
    DROP TABLE IF EXISTS lemma_rank;
    DROP TABLE IF EXISTS meta;
    CREATE TABLE freq(word TEXT PRIMARY KEY, rank INTEGER NOT NULL, lemma TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE lemma_rank(lemma TEXT PRIMARY KEY, rank INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """
)
db.executemany("INSERT OR IGNORE INTO freq VALUES (?, ?, ?)", rows)
db.executemany("INSERT INTO lemma_rank VALUES (?, ?)", sorted(family.items(), key=lambda x: x[1]))
db.execute("INSERT INTO meta VALUES ('wordfreq_version', ?)", (version("wordfreq"),))
db.commit()
db.execute("VACUUM")
db.close()

print(f"wordfreq {version('wordfreq')}: {len(rows)} 字 → {len(family)} 個原形家族（排除人名 {names}）→ {DB}")
