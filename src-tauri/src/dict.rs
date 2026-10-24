// 查字典：離線 ECDICT（中文釋義、音標、詞形）+ 線上 dictionaryapi.dev（發音音檔、英英例句）。
use crate::db::{err, Dict};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub word: String,
    pub phonetic: Option<String>,
    pub translation: Option<String>,
    pub definition: Option<String>,
    pub tag: Option<String>,
    pub collins: i64,
    pub oxford: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    /// 點到的字本身（例如 running）
    pub entry: Option<DictEntry>,
    /// 原形（例如 run），點到的字是變化形時才有
    pub lemma: Option<DictEntry>,
}

fn row_entry(r: &Row) -> rusqlite::Result<(DictEntry, Option<String>)> {
    Ok((
        DictEntry {
            word: r.get(0)?,
            phonetic: r.get(1)?,
            translation: r.get(2)?,
            definition: r.get(3)?,
            tag: r.get(5)?,
            collins: r.get(6)?,
            oxford: r.get(7)?,
        },
        r.get(4)?,
    ))
}

fn find(conn: &rusqlite::Connection, word: &str) -> rusqlite::Result<Option<(DictEntry, Option<String>)>> {
    conn.prepare_cached(
        "SELECT word, phonetic, translation, definition, exchange, tag, collins, oxford FROM dict WHERE word = ?1",
    )?
    .query_row(params![word], row_entry)
    .optional()
}

// exchange 格式：0:run/1:i/i:running → 0 = 原形
fn lemma_of(exchange: &Option<String>) -> Option<String> {
    exchange.as_ref()?.split('/').find_map(|p| p.strip_prefix("0:").map(str::to_string))
}

pub fn normalize(word: &str) -> String {
    word.trim()
        .replace('’', "'")
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_lowercase()
}

pub fn lookup_in(conn: &rusqlite::Connection, raw: &str) -> rusqlite::Result<LookupResult> {
    let word = normalize(raw);
    let mut candidates = vec![word.clone()];
    for suffix in ["'s", "s'", "'"] {
        if let Some(stem) = word.strip_suffix(suffix) {
            candidates.push(stem.to_string());
        }
    }
    for cand in candidates {
        if let Some((entry, exchange)) = find(conn, &cand)? {
            let lemma = match lemma_of(&exchange) {
                Some(base) if base != entry.word.to_lowercase() => find(conn, &base)?.map(|(e, _)| e),
                _ => None,
            };
            return Ok(LookupResult { entry: Some(entry), lemma });
        }
    }
    Ok(LookupResult { entry: None, lemma: None })
}

#[tauri::command]
pub fn dict_lookup(dict: State<'_, Dict>, word: String) -> Result<LookupResult, String> {
    let conn = dict.0.lock().map_err(err)?;
    lookup_in(&conn, &word).map_err(err)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OnlineInfo {
    pub audio_url: Option<String>,
    pub phonetic: Option<String>,
    pub senses: Vec<Sense>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sense {
    pub pos: String,
    pub definition: String,
    pub example: Option<String>,
}

// 線上補充：發音音檔與英英例句。失敗就回空，不影響離線釋義。
#[tauri::command]
pub async fn dict_online(word: String) -> Result<OnlineInfo, String> {
    let word = normalize(&word);
    if word.is_empty() {
        return Ok(OnlineInfo::default());
    }
    let url = format!("https://api.dictionaryapi.dev/api/v2/entries/en/{word}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(err)?;
    let Ok(res) = client.get(url).send().await else { return Ok(OnlineInfo::default()) };
    if !res.status().is_success() {
        return Ok(OnlineInfo::default());
    }
    let data: serde_json::Value = res.json().await.map_err(err)?;
    let entries = data.as_array().cloned().unwrap_or_default();
    let mut info = OnlineInfo::default();
    for e in &entries {
        if info.phonetic.is_none() {
            info.phonetic = e["phonetic"].as_str().map(str::to_string);
        }
        for p in e["phonetics"].as_array().into_iter().flatten() {
            if info.audio_url.is_none() {
                info.audio_url = p["audio"].as_str().filter(|a| !a.is_empty()).map(|a| {
                    if a.starts_with("//") { format!("https:{a}") } else { a.to_string() }
                });
            }
        }
        for m in e["meanings"].as_array().into_iter().flatten() {
            let pos = m["partOfSpeech"].as_str().unwrap_or_default();
            for d in m["definitions"].as_array().into_iter().flatten().take(2) {
                if info.senses.len() >= 4 {
                    break;
                }
                if let Some(def) = d["definition"].as_str() {
                    info.senses.push(Sense {
                        pos: pos.to_string(),
                        definition: def.to_string(),
                        example: d["example"].as_str().map(str::to_string),
                    });
                }
            }
        }
    }
    Ok(info)
}
