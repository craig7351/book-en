// 本機資料：使用者資料庫（設定、翻譯快取、收藏、複習紀錄）與離線字典（唯讀）。
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);
pub struct Dict(pub Mutex<Connection>);

const SCHEMA: &str = "
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
CREATE TABLE IF NOT EXISTS review_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  quality INTEGER NOT NULL,
  quiz TEXT
);
";

pub fn open_user_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub fn open_dict(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
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
