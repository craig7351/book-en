// 字幕翻譯：先查快取，缺的整批交給本機 AI CLI（claude / codex / agy / gemini），依編號對齊後寫回快取。
use crate::ai_cli;
use crate::db::{err, Db};
use rusqlite::{params, OptionalExtension};
use tauri::State;

const PROMPT: &str = "You translate YouTube subtitles for a Taiwanese learner of English.
Translate each numbered line into natural Traditional Chinese as used in Taiwan (繁體中文，台灣用語).
The lines are consecutive subtitles and may be sentence fragments: use the surrounding lines for context,
but keep each translation aligned to its own line number. Keep names in English.
Reply with ONLY a JSON array, no other text: [{\"i\":1,\"zh\":\"...\"}, ...]

";

fn cached(db: &Db, lines: &[String]) -> Result<Vec<Option<String>>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn.prepare_cached("SELECT zh FROM translations WHERE text = ?1").map_err(err)?;
    lines
        .iter()
        .map(|line| stmt.query_row([line], |r| r.get(0)).optional().map_err(err))
        .collect()
}

// 只查快取、不呼叫 claude（AI 翻譯要使用者按按鈕才開始）
#[tauri::command]
pub fn translation_cached(db: State<'_, Db>, lines: Vec<String>) -> Result<Vec<Option<String>>, String> {
    cached(&db, &lines)
}

#[tauri::command]
pub async fn translate_batch(
    db: State<'_, Db>,
    lines: Vec<String>,
    model: String,
) -> Result<Vec<Option<String>>, String> {
    let mut out = cached(&db, &lines)?;
    let missing: Vec<usize> = (0..lines.len()).filter(|&i| out[i].is_none() && !lines[i].trim().is_empty()).collect();
    if missing.is_empty() {
        return Ok(out);
    }

    let mut prompt = PROMPT.to_string();
    for (n, &i) in missing.iter().enumerate() {
        prompt.push_str(&format!("{}. {}\n", n + 1, lines[i].replace('\n', " ")));
    }
    let m = model.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || ai_cli::run(&prompt, &m))
        .await
        .map_err(err)??;
    let arr = ai_cli::extract_json_array(&reply).ok_or("bad-reply")?;

    let conn = db.0.lock().map_err(err)?;
    for item in arr.as_array().into_iter().flatten() {
        let (Some(n), Some(zh)) = (item["i"].as_u64(), item["zh"].as_str()) else { continue };
        let Some(&i) = missing.get((n as usize).wrapping_sub(1)) else { continue };
        let zh = zh.trim().to_string();
        if zh.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR REPLACE INTO translations(text, zh, model) VALUES (?1, ?2, ?3)",
            params![lines[i], zh, model],
        )
        .map_err(err)?;
        out[i] = Some(zh);
    }
    Ok(out)
}

// 單字在這句裡的意思（AI 解釋）
#[tauri::command]
pub async fn ai_explain(word: String, sentence: String, model: String) -> Result<String, String> {
    let prompt = format!(
        "你是英文老師，學生是台灣人。請用繁體中文（台灣用語）簡短說明英文單字或片語「{word}」\
         在下面這句話中的意思與用法，2 到 3 句話，不要加標題或 Markdown。\n\n句子：{sentence}"
    );
    tauri::async_runtime::spawn_blocking(move || ai_cli::run(&prompt, &model))
        .await
        .map_err(err)?
}

/// AI CLI 的版本（順便確認裝了沒）；provider = claude / codex / agy / gemini
#[tauri::command]
pub async fn ai_status(provider: String) -> Result<String, String> {
    let cli = ai_cli::Cli::from_id(&provider).ok_or("bad-provider")?;
    tauri::async_runtime::spawn_blocking(move || ai_cli::version(cli)).await.map_err(err)?
}

/// 可選的模型 [(id, 名稱)]
#[tauri::command]
pub async fn ai_models(provider: String) -> Result<Vec<(String, String)>, String> {
    let cli = ai_cli::Cli::from_id(&provider).ok_or("bad-provider")?;
    tauri::async_runtime::spawn_blocking(move || ai_cli::models(cli)).await.map_err(err)?
}
