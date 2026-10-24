// 收藏（單字 / 句子）與間隔重複複習（SM-2）。
use crate::db::{err, now_ms, Db, Dict};
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
}

const COLS: &str = "id, kind, text, phonetic, meaning_zh, context, context_zh, video_id, video_title, t, \
                    created_at, due_at, interval_days, ease, reps, lapses";

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
}

// 收藏；已存在就回傳原本那筆（不重複、不重置複習進度）
#[tauri::command]
pub fn item_add(db: State<'_, Db>, item: ItemInput) -> Result<Item, String> {
    let text = item.text.trim().to_string();
    if text.is_empty() || !(item.kind == "word" || item.kind == "sentence") {
        return Err("invalid-item".into());
    }
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    conn.execute(
        "INSERT OR IGNORE INTO items(kind, text, phonetic, meaning_zh, context, context_zh, video_id, video_title, t, created_at, due_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![item.kind, text, item.phonetic, item.meaning_zh, item.context, item.context_zh,
                item.video_id, item.video_title, item.t, now],
    )
    .map_err(err)?;
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

#[tauri::command]
pub fn review_due(db: State<'_, Db>, limit: i64) -> Result<Vec<Item>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM items WHERE due_at <= ?1 ORDER BY due_at LIMIT ?2"))
        .map_err(err)?;
    let rows = stmt.query_map(params![now_ms(), limit], row_item).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
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

#[tauri::command]
pub fn review_grade(db: State<'_, Db>, id: i64, quality: i64, quiz: String) -> Result<Item, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut item = get_item(&conn, id).map_err(err)?;
    let now = now_ms();
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
    Ok(item)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub words: i64,
    pub sentences: i64,
    pub due: i64,
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
    let due = count("SELECT COUNT(*) FROM items WHERE due_at <= ?1", &[&now_ms()])?;
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
    Ok(Stats { words, sentences, due, reviewed_today, streak_days })
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
    if (out.len() as i64) < n {
        let conn = dict.0.lock().map_err(err)?;
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
