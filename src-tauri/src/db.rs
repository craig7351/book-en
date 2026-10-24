// 本機資料：使用者資料庫（設定、翻譯快取、收藏、複習紀錄）與離線字典（唯讀）。
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);
/// 離線字典；None = 沒找到 ecdict.db（使用者選擇不下載時 App 仍可使用，查字 / 分級 / 例句庫停用）
pub struct Dict(pub Mutex<Option<Connection>>);

pub const NO_DICT: &str = "no-dict";

/// 使用者資料夾（預設 App 資料夾；BOOKEN_DATA_DIR 可改，測試用）
pub struct DataDir(pub std::path::PathBuf);

pub const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS translations(
  text TEXT PRIMARY KEY,
  zh TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('word', 'sentence')),
  text TEXT NOT NULL,
  phonetic TEXT,
  meaning_zh TEXT,
  context TEXT,
  context_zh TEXT,
  video_id TEXT,
  video_title TEXT,
  t REAL,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, text)
);
CREATE TABLE IF NOT EXISTS bookmarks(
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS word_status(
  lemma TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('known', 'ignore')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_words(
  lemma TEXT PRIMARY KEY,
  rank INTEGER,
  first_video TEXT,
  first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_examples(
  lemma TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  quality INTEGER NOT NULL,
  quiz TEXT
);
-- 遊戲模式（寵物養成，game.rs）：預設關閉，關閉時不寫入
CREATE TABLE IF NOT EXISTS pets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  species TEXT NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  shiny INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  accessories TEXT NOT NULL DEFAULT '[]',
  hatched_at INTEGER NOT NULL,
  teen_at INTEGER
);
CREATE TABLE IF NOT EXISTS eggs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  species TEXT NOT NULL,
  warmth INTEGER NOT NULL DEFAULT 0,
  incubating INTEGER NOT NULL DEFAULT 0,
  obtained_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT
);
CREATE TABLE IF NOT EXISTS pet_xp_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  review_id INTEGER
);
CREATE TABLE IF NOT EXISTS inventory(
  item TEXT PRIMARY KEY,
  qty INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS game_daily(
  day INTEGER PRIMARY KEY,
  due_reviews INTEGER NOT NULL DEFAULT 0,
  practice INTEGER NOT NULL DEFAULT 0,
  practice_xp INTEGER NOT NULL DEFAULT 0,
  collect_coins INTEGER NOT NULL DEFAULT 0,
  all_due_done INTEGER NOT NULL DEFAULT 0,
  freeze_used INTEGER NOT NULL DEFAULT 0,
  snack INTEGER NOT NULL DEFAULT 0
);
";

pub fn open_user_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 舊資料庫補欄位（CREATE TABLE IF NOT EXISTS 不會幫已存在的表加欄位）
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    if !column_exists(conn, "items", "audio_urls") {
        // 單字的真人錄音網址（JSON 陣列），收藏時從線上字典帶過來
        conn.execute_batch("ALTER TABLE items ADD COLUMN audio_urls TEXT")?;
    }
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> bool {
    conn.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))
        .and_then(|mut s| s.exists([col]))
        .unwrap_or(false)
}

pub fn open_dict(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    // 確認真的是字典（避免半截或錯的檔案）
    conn.query_row("SELECT COUNT(*) FROM dict LIMIT 1", [], |r| r.get::<_, i64>(0))?;
    Ok(conn)
}

pub fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |_| Ok(()))
        .is_ok()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_adds_audio_column_once() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // 第二次不能出錯
        assert!(column_exists(&conn, "items", "audio_urls"));
    }
}
