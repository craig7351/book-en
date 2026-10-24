// 單字卡例句（M10）：例句庫（Tatoeba，離線，在 ecdict.db）與 AI 例句（claude -p，依原形快取）。
use crate::claude;
use crate::db::{self, err, now_ms, Db, Dict};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone)]
pub struct Example {
    pub en: String,
    pub zh: Option<String>,
}

// 依難度（句中其他字最難的排名）由易到難，再依長短
#[tauri::command]
pub fn examples_for(dict: State<'_, Dict>, lemma: String, limit: i64) -> Result<Vec<Example>, String> {
    let guard = dict.0.lock().map_err(err)?;
    let Some(conn) = guard.as_ref() else { return Ok(vec![]) };
    if !db::table_exists(conn, "examples") {
        return Ok(vec![]); // 舊版字典沒有例句庫
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT e.en, e.zh FROM example_index i JOIN examples e ON e.id = i.id
             WHERE i.lemma = ?1 ORDER BY i.difficulty, i.len LIMIT ?2",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![lemma.to_lowercase(), limit], |r| Ok(Example { en: r.get(0)?, zh: r.get(1)? }))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// AI 例句：依使用者程度產生 3 句＋中文。同一個原形只產生一次（refresh = true 重新產生）。
#[tauri::command]
pub async fn ai_examples(
    db: State<'_, Db>,
    lemma: String,
    known_max: i64,
    model: String,
    refresh: Option<bool>,
) -> Result<Vec<Example>, String> {
    let lemma = lemma.trim().to_lowercase();
    if lemma.is_empty() || lemma.len() > 40 || !lemma.chars().all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-') {
        return Err("invalid-word".into());
    }
    if !refresh.unwrap_or(false) {
        let conn = db.0.lock().map_err(err)?;
        let cached: Option<String> = conn
            .query_row("SELECT json FROM ai_examples WHERE lemma = ?1", [&lemma], |r| r.get(0))
            .optional()
            .map_err(err)?;
        if let Some(json) = cached {
            return serde_json::from_str(&json).map_err(err);
        }
    }
    let prompt = format!(
        "Write 3 short, natural English example sentences using the word \"{lemma}\" (any form of it is fine).\n\
         Use mostly very common words (roughly the {known_max} most frequent English words) so a learner can focus on \"{lemma}\".\n\
         If the word has several common meanings or uses, show different ones.\n\
         Give each sentence a natural Traditional Chinese translation as used in Taiwan.\n\
         Reply with ONLY a JSON array, no other text: [{{\"en\":\"...\",\"zh\":\"...\"}}]"
    );
    let m = model.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || claude::run(&prompt, &m)).await.map_err(err)??;
    let arr = claude::extract_json_array(&reply).ok_or("bad-reply")?;
    let examples: Vec<Example> = arr
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let en = v["en"].as_str()?.trim().to_string();
            (!en.is_empty()).then(|| Example { en, zh: v["zh"].as_str().map(|s| s.trim().to_string()) })
        })
        .take(5)
        .collect();
    if examples.is_empty() {
        return Err("bad-reply".into());
    }
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "INSERT OR REPLACE INTO ai_examples(lemma, json, model, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![lemma, serde_json::to_string(&examples).map_err(err)?, model, now_ms()],
    )
    .map_err(err)?;
    Ok(examples)
}
