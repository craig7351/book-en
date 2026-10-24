// 詞頻分級（M9）：wordfreq 原形家族排名 + 個人狀態（已知 / 學習中 / 不要學）。
// 排名在離線字典 ecdict.db 的 freq / lemma_rank 表（tools/build-freq.py 產生）；個人狀態在使用者資料庫。
use crate::db::{err, now_ms, Db, Dict};
use crate::dict::normalize;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordInfo {
    pub word: String,
    pub lemma: String,
    pub rank: Option<i64>,
    /// known / ignore（手動）、learning（已收藏）；None = 依排名分級
    pub status: Option<String>,
}

// 原形：wordfreq 表有就用；否則看 ECDICT 的 exchange（0:原形）；再不行去掉 's
pub fn lemma_and_rank(dict: &rusqlite::Connection, word: &str) -> rusqlite::Result<(String, Option<i64>)> {
    let mut lemma: Option<String> = dict
        .prepare_cached("SELECT lemma FROM freq WHERE word = ?1")?
        .query_row([word], |r| r.get(0))
        .optional()?;
    if lemma.is_none() {
        let exchange: Option<Option<String>> = dict
            .prepare_cached("SELECT exchange FROM dict WHERE word = ?1")?
            .query_row([word], |r| r.get(0))
            .optional()?;
        lemma = exchange
            .flatten()
            .and_then(|ex| ex.split('/').find_map(|p| p.strip_prefix("0:").map(|s| s.to_lowercase())));
    }
    let lemma = lemma.unwrap_or_else(|| word.strip_suffix("'s").unwrap_or(word).to_string());
    let rank: Option<i64> = dict
        .prepare_cached("SELECT rank FROM lemma_rank WHERE lemma = ?1")?
        .query_row([&lemma], |r| r.get(0))
        .optional()?;
    Ok((lemma, rank))
}

// 個人狀態：手動（known / ignore）優先，其次已收藏 = learning
fn statuses(db: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let mut stmt = db.prepare("SELECT text FROM items WHERE kind = 'word'")?;
    for t in stmt.query_map([], |r| r.get::<_, String>(0))? {
        out.insert(t?.to_lowercase(), "learning".to_string());
    }
    let mut stmt = db.prepare("SELECT lemma, status FROM word_status")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (lemma, status) = row?;
        out.insert(lemma, status);
    }
    Ok(out)
}

// 一支影片的所有字一次查（約 1–2 千個不重複字）；同時記錄「看過的字」給詞彙頁統計
#[tauri::command]
pub fn word_info(
    db: State<'_, Db>,
    dict: State<'_, Dict>,
    words: Vec<String>,
    video_id: Option<String>,
) -> Result<Vec<WordInfo>, String> {
    let mut infos = Vec::with_capacity(words.len());
    {
        let dict = dict.0.lock().map_err(err)?;
        for raw in words {
            let word = normalize(&raw);
            if word.is_empty() {
                continue;
            }
            let (lemma, rank) = lemma_and_rank(&dict, &word).map_err(err)?;
            infos.push(WordInfo { word, lemma, rank, status: None });
        }
    }
    let conn = db.0.lock().map_err(err)?;
    let st = statuses(&conn).map_err(err)?;
    let now = now_ms();
    let mut seen = conn
        .prepare_cached("INSERT OR IGNORE INTO seen_words(lemma, rank, first_video, first_seen) VALUES (?1, ?2, ?3, ?4)")
        .map_err(err)?;
    let mut done = HashSet::new();
    for info in &mut infos {
        info.status = st.get(&info.lemma).cloned();
        if info.rank.is_some() && done.insert(info.lemma.clone()) {
            seen.execute(params![info.lemma, info.rank, video_id, now]).map_err(err)?;
        }
    }
    Ok(infos)
}

// status：known / ignore / None（清除，回到依排名分級）
#[tauri::command]
pub fn set_word_status(db: State<'_, Db>, lemmas: Vec<String>, status: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    for lemma in lemmas {
        let lemma = lemma.to_lowercase();
        match status.as_deref() {
            Some(s @ ("known" | "ignore")) => {
                conn.execute(
                    "INSERT OR REPLACE INTO word_status(lemma, status, updated_at) VALUES (?1, ?2, ?3)",
                    params![lemma, s, now],
                )
                .map_err(err)?;
            }
            None => {
                conn.execute("DELETE FROM word_status WHERE lemma = ?1", [lemma]).map_err(err)?;
            }
            Some(other) => return Err(format!("invalid-status: {other}")),
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedWord {
    pub lemma: String,
    pub rank: i64,
    pub status: Option<String>,
    pub seen: bool,
}

// 詞彙頁：排名 from..=to 的原形家族
#[tauri::command]
pub fn vocab_ranks(db: State<'_, Db>, dict: State<'_, Dict>, from: i64, to: i64) -> Result<Vec<RankedWord>, String> {
    let rows: Vec<(String, i64)> = {
        let dict = dict.0.lock().map_err(err)?;
        let mut stmt = dict
            .prepare("SELECT lemma, rank FROM lemma_rank WHERE rank BETWEEN ?1 AND ?2 ORDER BY rank")
            .map_err(err)?;
        let rows = stmt.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    let conn = db.0.lock().map_err(err)?;
    let st = statuses(&conn).map_err(err)?;
    let mut seen_stmt = conn.prepare_cached("SELECT 1 FROM seen_words WHERE lemma = ?1").map_err(err)?;
    let mut out = Vec::with_capacity(rows.len());
    for (lemma, rank) in rows {
        let seen = seen_stmt.exists([&lemma]).map_err(err)?;
        out.push(RankedWord { status: st.get(&lemma).cloned(), lemma, rank, seen });
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelCounts {
    pub known: i64,
    pub auto: i64,
    pub learning: i64,
    pub suggested: i64,
    pub ignored: i64,
    pub rare: i64,
    /// 估計詞彙量 = 自動已知 + 手動已知（排名超出自動範圍的）
    pub vocab_size: i64,
}

// 計數：建議 / 罕見只算「看過且沒有個人狀態」的字（同 Language Reactor）
#[tauri::command]
pub fn level_counts(
    db: State<'_, Db>,
    dict: State<'_, Dict>,
    known_max: i64,
    suggest_max: i64,
) -> Result<LevelCounts, String> {
    let (st, seen) = {
        let conn = db.0.lock().map_err(err)?;
        let st = statuses(&conn).map_err(err)?;
        let mut stmt = conn.prepare("SELECT lemma, rank FROM seen_words WHERE rank IS NOT NULL").map_err(err)?;
        let seen: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        (st, seen)
    };
    let count = |s: &str| st.values().filter(|v| *v == s).count() as i64;
    let mut suggested = 0;
    let mut rare = 0;
    for (lemma, rank) in &seen {
        if st.contains_key(lemma) {
            continue;
        }
        if *rank > known_max && *rank <= suggest_max {
            suggested += 1;
        } else if *rank > suggest_max {
            rare += 1;
        }
    }
    // 手動標已知、但不在自動已知範圍內的字（含沒排名的）也算進詞彙量
    let known_beyond_auto = {
        let dict = dict.0.lock().map_err(err)?;
        let mut stmt = dict.prepare_cached("SELECT rank FROM lemma_rank WHERE lemma = ?1").map_err(err)?;
        let mut n = 0;
        for (lemma, s) in &st {
            if s != "known" {
                continue;
            }
            let rank: Option<i64> = stmt.query_row([lemma], |r| r.get(0)).optional().map_err(err)?;
            if rank.map_or(true, |r| r > known_max) {
                n += 1;
            }
        }
        n
    };
    Ok(LevelCounts {
        known: count("known"),
        auto: known_max,
        learning: count("learning"),
        suggested,
        ignored: count("ignore"),
        rare,
        vocab_size: known_max + known_beyond_auto,
    })
}
