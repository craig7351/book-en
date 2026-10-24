// 書籤（頂部網址列的 ⭐ / 📑）。存 SQLite，不用 localStorage（yt-float 陷阱 8）。
use crate::db::{err, now_ms, Db};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub url: String,
    pub title: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn bookmark_list(db: State<'_, Db>) -> Result<Vec<Bookmark>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT url, title, created_at FROM bookmarks ORDER BY created_at DESC")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok(Bookmark { url: r.get(0)?, title: r.get(1)?, created_at: r.get(2)? }))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// 已收藏就移除、沒有就加入；回傳操作後是否為書籤
#[tauri::command]
pub fn bookmark_toggle(db: State<'_, Db>, url: String, title: String) -> Result<bool, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid-url".into());
    }
    let conn = db.0.lock().map_err(err)?;
    if conn.execute("DELETE FROM bookmarks WHERE url = ?1", [&url]).map_err(err)? > 0 {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO bookmarks(url, title, created_at) VALUES (?1, ?2, ?3)",
        params![url, title.trim(), now_ms()],
    )
    .map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn bookmark_delete(db: State<'_, Db>, url: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM bookmarks WHERE url = ?1", [url]).map_err(err)?;
    Ok(())
}
