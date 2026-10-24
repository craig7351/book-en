// 收藏（單字 / 句子）與間隔重複複習（SM-2）。
use crate::db::{err, now_ms, Db, Dict};
use crate::game;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

const DAY_MS: f64 = 86_400_000.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub kind: String,
    pub text: String,
    pub phonetic: Option<String>,
    pub meaning_zh: Option<String>,
    pub context: Option<String>,
    pub context_zh: Option<String>,
    pub video_id: Option<String>,
    pub video_title: Option<String>,
    pub t: Option<f64>,
    pub created_at: i64,
    pub due_at: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub audio_urls: Vec<String>,
    pub suspended: bool,
}

const COLS: &str = "id, kind, text, phonetic, meaning_zh, context, context_zh, video_id, video_title, t, \
                    created_at, due_at, interval_days, ease, reps, lapses, audio_urls, suspended";

fn row_item(r: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        kind: r.get(1)?,
        text: r.get(2)?,
        phonetic: r.get(3)?,
        meaning_zh: r.get(4)?,
        context: r.get(5)?,
        context_zh: r.get(6)?,
        video_id: r.get(7)?,
        video_title: r.get(8)?,
        t: r.get(9)?,
        created_at: r.get(10)?,
        due_at: r.get(11)?,
        interval_days: r.get(12)?,
        ease: r.get(13)?,
        reps: r.get(14)?,
        lapses: r.get(15)?,
        audio_urls: r
            .get::<_, Option<String>>(16)?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default(),
        suspended: r.get::<_, i64>(17)? != 0,
    })
}

fn get_item(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Item> {
    conn.query_row(&format!("SELECT {COLS} FROM items WHERE id = ?1"), [id], row_item)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub kind: String,
    pub text: String,
    pub phonetic: Option<String>,
    pub meaning_zh: Option<String>,
    pub context: Option<String>,
    pub context_zh: Option<String>,
    pub video_id: Option<String>,
    pub video_title: Option<String>,
    pub t: Option<f64>,
    #[serde(default)]
    pub audio_urls: Vec<String>,
}

// 收藏；已存在就回傳原本那筆（不重複、不重置複習進度）
#[tauri::command]
pub fn item_add(db: State<'_, Db>, item: ItemInput, day_start: Option<i64>) -> Result<Item, String> {
    let text = item.text.trim().to_string();
    if text.is_empty() || !(item.kind == "word" || item.kind == "sentence") {
        return Err("invalid-item".into());
    }
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO items(kind, text, phonetic, meaning_zh, context, context_zh, video_id, video_title, t, created_at, due_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![item.kind, text, item.phonetic, item.meaning_zh, item.context, item.context_zh,
                item.video_id, item.video_title, item.t, now],
    )
    .map_err(err)?;
    // 錄音網址：新收藏直接存；舊的收藏還沒有就補上
    if !item.audio_urls.is_empty() {
        conn.execute(
            "UPDATE items SET audio_urls = ?3 WHERE kind = ?1 AND text = ?2 AND (audio_urls IS NULL OR audio_urls = '[]')",
            params![item.kind, text, serde_json::to_string(&item.audio_urls).map_err(err)?],
        )
        .map_err(err)?;
    }
    if inserted > 0 && item.kind == "word" {
        game::on_collect(&conn, game::sane_day(day_start, now), now).map_err(err)?;
    }
    let id: i64 = conn
        .query_row("SELECT id FROM items WHERE kind = ?1 AND text = ?2", params![item.kind, text], |r| r.get(0))
        .map_err(err)?;
    get_item(&conn, id).map_err(err)
}

#[tauri::command]
pub fn item_delete(db: State<'_, Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM review_log WHERE item_id = ?1", [id]).map_err(err)?;
    conn.execute("DELETE FROM items WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn item_list(db: State<'_, Db>, query: Option<String>) -> Result<Vec<Item>, String> {
    let conn = db.0.lock().map_err(err)?;
    let q = format!("%{}%", query.unwrap_or_default().trim());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLS} FROM items WHERE text LIKE ?1 OR meaning_zh LIKE ?1 OR context LIKE ?1 ORDER BY created_at DESC"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([q], row_item).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// 字幕上色用：已收藏的單字
#[tauri::command]
pub fn saved_words(db: State<'_, Db>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn.prepare("SELECT text FROM items WHERE kind = 'word'").map_err(err)?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// ---- 每天新字上限 ----
// 「新字」= 收藏後還沒複習過的項目。新收藏的會立刻到期，一次收太多會被複習淹沒 → 每天只出 N 個新字（設定 prefs.newPerDay，0 = 不限）

const IS_NEW: &str = "NOT EXISTS (SELECT 1 FROM review_log r WHERE r.item_id = items.id)";
pub const DEFAULT_NEW_PER_DAY: i64 = 20;

pub fn new_per_day(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT value FROM settings WHERE key = 'prefs'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["newPerDay"].as_i64())
        .unwrap_or(DEFAULT_NEW_PER_DAY)
}

/// 今天還能出幾個新字（今天第一次複習的項目算「今天出過的新字」）
fn new_allowance(conn: &rusqlite::Connection, day: i64) -> rusqlite::Result<i64> {
    let limit = new_per_day(conn);
    if limit <= 0 {
        return Ok(i64::MAX / 2);
    }
    let introduced: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (SELECT MIN(at) AS first FROM review_log GROUP BY item_id) WHERE first >= ?1",
        [day],
        |r| r.get(0),
    )?;
    Ok((limit - introduced).max(0))
}

pub struct DueCounts {
    pub reviews: i64, // 複習過、到期的
    pub new_today: i64, // 今天會出的新字
    pub new_waiting: i64, // 超過今天上限、之後再出的新字
}

pub fn due_counts(conn: &rusqlite::Connection, day: i64, now: i64) -> rusqlite::Result<DueCounts> {
    let reviews: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM items WHERE suspended = 0 AND due_at <= ?1 AND NOT {IS_NEW}"),
        [now],
        |r| r.get(0),
    )?;
    let new_total: i64 =
        conn.query_row(&format!("SELECT COUNT(*) FROM items WHERE suspended = 0 AND {IS_NEW}"), [], |r| r.get(0))?;
    let new_today = new_total.min(new_allowance(conn, day)?);
    Ok(DueCounts { reviews, new_today, new_waiting: new_total - new_today })
}

/// 待複習：先出複習過、到期的（最早到期的先），再出今天額度內的新字（最早收藏的先）
#[tauri::command]
pub fn review_due(db: State<'_, Db>, limit: i64, day_start: Option<i64>) -> Result<Vec<Item>, String> {
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    let day = crate::game::sane_day(day_start, now);
    let query = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<Vec<Item>, String> {
        let mut stmt = conn.prepare(sql).map_err(err)?;
        let rows = stmt.query_map(p, row_item).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    };
    let mut items = query(
        &format!("SELECT {COLS} FROM items WHERE suspended = 0 AND due_at <= ?1 AND NOT {IS_NEW} ORDER BY due_at LIMIT ?2"),
        &[&now, &limit],
    )?;
    let room = (limit - items.len() as i64).min(new_allowance(&conn, day).map_err(err)?);
    if room > 0 {
        items.extend(query(
            &format!("SELECT {COLS} FROM items WHERE suspended = 0 AND {IS_NEW} ORDER BY created_at LIMIT ?1"),
            &[&room],
        )?);
    }
    Ok(items)
}

/// 批次刪除（含複習紀錄）
#[tauri::command]
pub fn item_delete_many(db: State<'_, Db>, ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    for id in &ids {
        tx.execute("DELETE FROM review_log WHERE item_id = ?1", [id]).map_err(err)?;
        tx.execute("DELETE FROM items WHERE id = ?1", [id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(ids.len())
}

/// 暫停 / 恢復複習
#[tauri::command]
pub fn item_suspend(db: State<'_, Db>, ids: Vec<i64>, on: bool) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    for id in &ids {
        tx.execute("UPDATE items SET suspended = ?2 WHERE id = ?1", params![id, on as i64]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

// SM-2：quality 0–5（< 3 視為忘記）。忘記的字 10 分鐘後再出現。
pub fn schedule(item: &mut Item, quality: i64, now: i64) {
    let q = quality.clamp(0, 5) as f64;
    if q < 3.0 {
        item.reps = 0;
        item.lapses += 1;
        item.interval_days = 0.0;
        item.due_at = now + 10 * 60 * 1000;
    } else {
        item.reps += 1;
        item.interval_days = match item.reps {
            1 => 1.0,
            2 => 6.0,
            _ => (item.interval_days * item.ease).round().max(1.0),
        };
        item.due_at = now + (item.interval_days * DAY_MS) as i64;
    }
    item.ease = (item.ease + 0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02)).max(1.3);
}

#[derive(Serialize)]
pub struct GradeResult {
    pub item: Item,
    /// 遊戲模式開啟時這題得到的獎勵
    pub reward: Option<game::Reward>,
}

#[tauri::command]
pub fn review_grade(
    db: State<'_, Db>,
    id: i64,
    quality: i64,
    quiz: String,
    day_start: Option<i64>,
) -> Result<GradeResult, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut item = get_item(&conn, id).map_err(err)?;
    let now = now_ms();
    let was_due = item.due_at <= now;
    schedule(&mut item, quality, now);
    conn.execute(
        "UPDATE items SET due_at = ?2, interval_days = ?3, ease = ?4, reps = ?5, lapses = ?6 WHERE id = ?1",
        params![id, item.due_at, item.interval_days, item.ease, item.reps, item.lapses],
    )
    .map_err(err)?;
    conn.execute(
        "INSERT INTO review_log(item_id, at, quality, quiz) VALUES (?1, ?2, ?3, ?4)",
        params![id, now, quality, quiz],
    )
    .map_err(err)?;
    let review_id = conn.last_insert_rowid();
    let reward =
        game::on_review(&conn, review_id, quality, was_due, game::sane_day(day_start, now), now).map_err(err)?;
    Ok(GradeResult { item, reward })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub words: i64,
    pub sentences: i64,
    pub due: i64,
    pub new_waiting: i64, // 超過今天新字上限、之後再出的
    pub reviewed_today: i64,
    pub streak_days: i64,
}

#[tauri::command]
pub fn stats(db: State<'_, Db>, day_start: i64) -> Result<Stats, String> {
    let conn = db.0.lock().map_err(err)?;
    let count = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<i64, String> {
        conn.query_row(sql, p, |r| r.get(0)).map_err(err)
    };
    let words = count("SELECT COUNT(*) FROM items WHERE kind = 'word'", &[])?;
    let sentences = count("SELECT COUNT(*) FROM items WHERE kind = 'sentence'", &[])?;
    let dc = due_counts(&conn, day_start, now_ms()).map_err(err)?;
    let (due, new_waiting) = (dc.reviews + dc.new_today, dc.new_waiting);
    let reviewed_today = count("SELECT COUNT(*) FROM review_log WHERE at >= ?1", &[&day_start])?;
    // 連續學習天數：從今天（day_start = 使用者當地今天 0 點）往回數每天都有複習紀錄的天數；
    // 今天還沒複習不算中斷，從昨天開始數
    let day = DAY_MS as i64;
    let reviews_on = |start: i64| {
        count("SELECT COUNT(*) FROM review_log WHERE at >= ?1 AND at < ?2", &[&start, &(start + day)])
    };
    let mut start = if reviewed_today > 0 { day_start } else { day_start - day };
    let mut streak_days = 0;
    while reviews_on(start)? > 0 {
        streak_days += 1;
        start -= day;
    }
    Ok(Stats { words, sentences, due, new_waiting, reviewed_today, streak_days })
}

// 選擇題誘答：優先用自己收藏的其他單字，不夠再從字典常用字補
#[tauri::command]
pub fn quiz_distractors(db: State<'_, Db>, dict: State<'_, Dict>, exclude: String, n: i64) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = {
        let conn = db.0.lock().map_err(err)?;
        let mut stmt = conn
            .prepare("SELECT text FROM items WHERE kind = 'word' AND text != ?1 ORDER BY RANDOM() LIMIT ?2")
            .map_err(err)?;
        let rows = stmt.query_map(params![exclude, n], |r| r.get(0)).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    let guard = dict.0.lock().map_err(err)?;
    if let (true, Some(conn)) = ((out.len() as i64) < n, guard.as_ref()) {
        let mut stmt = conn
            .prepare(
                "SELECT word FROM dict WHERE collins >= 3 AND word != ?1 AND word NOT LIKE '% %' \
                 ORDER BY RANDOM() LIMIT ?2",
            )
            .map_err(err)?;
        let rows = stmt.query_map(params![exclude, n - out.len() as i64], |r| r.get(0)).map_err(err)?;
        for w in rows {
            out.push(w.map_err(err)?);
        }
    }
    Ok(out)
}

// 匯出到「下載」資料夾：csv（Excel 可開，含 BOM）或 anki（Tab 分隔，可直接匯入 Anki）
#[tauri::command]
pub fn export_items(app: tauri::AppHandle, db: State<'_, Db>, format: String) -> Result<String, String> {
    use tauri::Manager;
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM items ORDER BY created_at")).map_err(err)?;
    let items: Vec<Item> = stmt.query_map([], row_item).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let s = |o: &Option<String>| o.clone().unwrap_or_default();
    let (name, body) = if format == "anki" {
        let clean = |t: String| t.replace(['\t', '\n'], " ");
        let lines: Vec<String> = items
            .iter()
            .map(|i| {
                let back = format!("{}<br>{}<br><i>{}</i><br>{}", s(&i.phonetic), s(&i.meaning_zh), s(&i.context), s(&i.context_zh));
                format!("{}\t{}", clean(i.text.clone()), clean(back))
            })
            .collect();
        ("book-en-anki.txt", lines.join("\n"))
    } else {
        let q = |t: String| format!("\"{}\"", t.replace('"', "\"\""));
        let mut lines = vec!["kind,text,phonetic,meaning_zh,context,context_zh,video,reps,interval_days".to_string()];
        for i in &items {
            let video = i.video_id.as_ref().map(|v| format!("https://youtu.be/{v}?t={}", i.t.unwrap_or(0.0) as i64));
            lines.push(
                [i.kind.clone(), i.text.clone(), s(&i.phonetic), s(&i.meaning_zh), s(&i.context), s(&i.context_zh),
                 video.unwrap_or_default(), i.reps.to_string(), i.interval_days.to_string()]
                    .map(q)
                    .join(","),
            );
        }
        ("book-en-vocab.csv", format!("\u{feff}{}", lines.join("\r\n")))
    };
    let dir = app.path().download_dir().map_err(err)?;
    let path = dir.join(name);
    std::fs::write(&path, body).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

// ---- 設定（JSON 字串，畫面端自己解讀）----

#[tauri::command]
pub fn get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(err)
}

#[tauri::command]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)", params![key, value])
        .map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod due_tests {
    use super::*;

    fn db(new_per_day: i64) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('prefs', ?1)",
            [format!("{{\"newPerDay\":{new_per_day}}}")],
        )
        .unwrap();
        for i in 0..30 {
            conn.execute(
                "INSERT INTO items(kind, text, created_at, due_at) VALUES ('word', ?1, ?2, ?2)",
                params![format!("w{i}"), i],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn new_per_day_limit() {
        let conn = db(10);
        let (day, now) = (1_000, 2_000);
        let d = due_counts(&conn, day, now).unwrap();
        assert_eq!((d.reviews, d.new_today, d.new_waiting), (0, 10, 20));
        // 今天複習了 3 個新字 → 剩 7 個額度；那 3 個排到明天（答對）
        for id in 1..=3 {
            conn.execute("INSERT INTO review_log(item_id, at, quality) VALUES (?1, 1500, 4)", [id]).unwrap();
            conn.execute("UPDATE items SET due_at = 999999 WHERE id = ?1", [id]).unwrap();
        }
        let d = due_counts(&conn, day, now).unwrap();
        assert_eq!((d.reviews, d.new_today, d.new_waiting), (0, 7, 20));
        // 暫停的不算
        conn.execute("UPDATE items SET suspended = 1 WHERE id > 20", []).unwrap();
        let d = due_counts(&conn, day, now).unwrap();
        assert_eq!((d.new_today, d.new_waiting), (7, 10));
    }

    #[test]
    fn unlimited_when_zero() {
        let conn = db(0);
        let d = due_counts(&conn, 0, 100).unwrap();
        assert_eq!((d.new_today, d.new_waiting), (30, 0));
    }
}
