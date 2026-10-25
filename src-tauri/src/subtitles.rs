// AI 翻譯好的雙語字幕存成檔案：exe 同目錄的 subtitles\<影片ID>.json，下次直接選用、不用再翻。
// exe 目錄不能寫（例如裝在 Program Files）時退回 App 資料夾。
use crate::db::{err, now_ms};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubLine {
    pub start: f64,
    pub end: f64,
    pub en: String,
    pub zh: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSubs {
    pub video_id: String,
    pub title: String,
    pub model: String,
    #[serde(default)]
    pub saved_at: i64,
    pub complete: bool,
    pub lines: Vec<SubLine>,
    /// 讀取時才填：檔案實際位置
    #[serde(default, skip_deserializing, skip_serializing_if = "String::is_empty")]
    pub path: String,
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// 依序：exe 同目錄（Windows）、App 資料夾。
// macOS 不寫進 .app 裡（會破壞簽章）；Linux 的 AppImage / deb 執行檔目錄本來就不能寫。
fn dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("subtitles"))) {
        out.push(dir);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        out.push(dir.join("subtitles"));
    }
    out
}

#[tauri::command]
pub fn save_subtitles(app: tauri::AppHandle, mut subs: SavedSubs) -> Result<String, String> {
    if !valid_id(&subs.video_id) {
        return Err("invalid-video-id".into());
    }
    subs.saved_at = now_ms();
    let json = serde_json::to_string_pretty(&subs).map_err(err)?;
    let mut last_err = String::from("no-dir");
    for dir in dirs(&app) {
        let file = dir.join(format!("{}.json", subs.video_id));
        let tmp = dir.join(format!("{}.json.tmp", subs.video_id));
        let result = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&tmp, &json))
            .and_then(|_| std::fs::rename(&tmp, &file)); // 原子寫入，避免半截檔
        match result {
            Ok(()) => return Ok(file.to_string_lossy().to_string()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// 網頁 AI 翻譯：題目存成文字檔放到「下載」資料夾（給想用附件上傳的 AI）
#[tauri::command]
pub fn save_webai_prompt(app: tauri::AppHandle, video_id: String, part: u32, text: String) -> Result<String, String> {
    if !valid_id(&video_id) || text.len() > 2_000_000 {
        return Err("invalid-prompt".into());
    }
    let dir = app.path().download_dir().map_err(err)?;
    let file = dir.join(format!("book-en_{video_id}_第{part}段.txt"));
    std::fs::write(&file, text).map_err(err)?;
    Ok(file.to_string_lossy().to_string())
}

/// 網頁 AI 翻譯：用系統瀏覽器開 AI 網站（只限這幾個，YouTube 頁面上的程式不能拿來開任意網址）
const AI_SITES: [&str; 4] =
    ["https://chatgpt.com/", "https://gemini.google.com/app", "https://claude.ai/new", "https://chat.deepseek.com/"];

#[tauri::command]
pub fn open_ai_site(url: String) -> Result<(), String> {
    if !AI_SITES.contains(&url.as_str()) {
        return Err("url-not-allowed".into());
    }
    #[cfg(windows)]
    let (prog, args) = ("rundll32", vec!["url.dll,FileProtocolHandler", url.as_str()]);
    #[cfg(target_os = "macos")]
    let (prog, args) = ("open", vec![url.as_str()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (prog, args) = ("xdg-open", vec![url.as_str()]);
    std::process::Command::new(prog).args(args).spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn load_subtitles(app: tauri::AppHandle, video_id: String) -> Result<Option<SavedSubs>, String> {
    if !valid_id(&video_id) {
        return Ok(None);
    }
    for dir in dirs(&app) {
        let file = dir.join(format!("{video_id}.json"));
        if let Ok(text) = std::fs::read_to_string(&file) {
            let mut subs: SavedSubs = serde_json::from_str(&text).map_err(err)?;
            subs.path = file.to_string_lossy().to_string();
            return Ok(Some(subs));
        }
    }
    Ok(None)
}
