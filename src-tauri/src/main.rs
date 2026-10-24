#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bookmarks;
mod claude;
mod db;
mod dict;
mod dictfile;
mod examples;
#[cfg(feature = "kokoro")]
mod g2p;
mod game;
mod kokoro;
mod levels;
mod subtitles;
mod translate;
mod vocab;

use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const START_URL: &str = "https://www.youtube.com";

// 注入 YouTube 的面板（Vite 打包的 IIFE）。
// 正式版編進執行檔；開發版每次啟動從檔案讀，改 UI 只要重跑 build:overlay、不用重編 Rust。
#[cfg(not(debug_assertions))]
fn overlay_js() -> String {
    include_str!("../gen-overlay/overlay.js").to_string()
}

#[cfg(debug_assertions)]
fn overlay_js() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/gen-overlay/overlay.js");
    std::fs::read_to_string(path).expect("找不到 overlay.js，請先執行 npm run build:overlay")
}

#[tauri::command]
fn ping(msg: String) -> String {
    format!("pong from Rust（{msg}）")
}

fn show_hub<R: tauri::Runtime, M: Manager<R>>(app: &M, tab: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("hub") {
        if let Some(tab) = tab {
            let _ = w.eval(format!("location.hash = {}", serde_json::to_string(&tab).map_err(db::err)?));
        }
        let _ = w.unminimize();
        return w.set_focus().map_err(db::err);
    }
    // 分頁不能放進 App 路徑（index.html#review 會被當成檔名找不到）→ 用初始化腳本帶過去
    let tab = serde_json::to_string(&tab.unwrap_or_default()).map_err(db::err)?;
    WebviewWindowBuilder::new(app, "hub", WebviewUrl::App("index.html".into()))
        .initialization_script(format!("window.__bookEnTab = {tab};"))
        .title("book-en 學習中心")
        .inner_size(1000.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .build()
        .map_err(db::err)?;
    Ok(())
}

// 打開學習中心（單字庫 / 複習 / 設定）；已開就帶到前景。
// 必須是 async：Windows 上在同步指令裡建立視窗會死結（視窗卡在 about:blank、invoke 永不返回）。
#[tauri::command]
async fn open_hub(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    show_hub(&app, tab)
}

// 學習中心 → 主視窗跳到影片的某一秒（複習時聽原句）
#[tauri::command]
async fn play_source(app: tauri::AppHandle, video_id: String, t: f64) -> Result<(), String> {
    if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid-video-id".into());
    }
    let win = app.get_webview_window("main").ok_or("no-main-window")?;
    let url = format!("https://www.youtube.com/watch?v={video_id}&t={}s", t.max(0.0) as i64);
    win.navigate(url.parse().map_err(db::err)?).map_err(db::err)?;
    let _ = win.unminimize();
    win.set_focus().map_err(db::err)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ping,
            open_hub,
            play_source,
            translate::translate_batch,
            translate::translation_cached,
            translate::ai_explain,
            translate::claude_status,
            dict::dict_lookup,
            dict::dict_online,
            vocab::item_add,
            vocab::item_delete,
            vocab::item_list,
            vocab::saved_words,
            vocab::review_due,
            vocab::review_grade,
            vocab::stats,
            vocab::quiz_distractors,
            vocab::export_items,
            vocab::get_setting,
            vocab::set_setting,
            bookmarks::bookmark_list,
            bookmarks::bookmark_toggle,
            bookmarks::bookmark_delete,
            subtitles::save_subtitles,
            subtitles::load_subtitles,
            levels::word_info,
            levels::set_word_status,
            levels::vocab_ranks,
            levels::level_counts,
            dictfile::dict_status,
            dictfile::dict_download,
            examples::examples_for,
            examples::ai_examples,
            game::game_state,
            game::game_enable,
            game::game_disable,
            game::game_options,
            game::pet_set_active,
            game::pet_rename,
            game::egg_incubate,
            game::pet_equip,
            game::shop_list,
            game::shop_buy,
            game::snack_use,
            game::game_practice,
            game::coin_history,
            kokoro::tts_speak,
            kokoro::tts_status,
            kokoro::tts_download,
            kokoro::tts_remove,
        ])
        .setup(|app| {
            // BOOKEN_DATA_DIR：改用別的資料夾放使用者資料庫（測試時不碰真實資料）
            let data_dir = match std::env::var_os("BOOKEN_DATA_DIR") {
                Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            app.manage(db::DataDir(data_dir.clone()));
            let user_db = db::open_user_db(&data_dir.join("book-en.db"))?;
            // 使用者選過「不下載，繼續使用」就不再自動跳出字典畫面
            let skip_prompt = user_db
                .query_row("SELECT value FROM settings WHERE key = 'dictPrompt'", [], |r| r.get::<_, String>(0))
                .map(|v| v == "skip")
                .unwrap_or(false);
            app.manage(db::Db(Mutex::new(user_db)));
            app.manage(kokoro::Kokoro::default());

            // 字典找不到也照樣開：查字 / 分級 / 例句庫停用，可在學習中心下載
            let (dict, dict_path) = dictfile::open_any(app.handle());
            let missing = dict.is_none();
            app.manage(db::Dict(Mutex::new(dict)));
            app.manage(dictfile::DictPath(Mutex::new(dict_path)));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(START_URL.parse()?))
                .title("book-en")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(overlay_js())
                .build()?;
            if missing && !skip_prompt {
                show_hub(app, Some("dict".into()))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sm2_schedule() {
        let mut it = vocab::Item {
            id: 1, kind: "word".into(), text: "run".into(), phonetic: None, meaning_zh: None,
            context: None, context_zh: None, video_id: None, video_title: None, t: None,
            created_at: 0, due_at: 0, interval_days: 0.0, ease: 2.5, reps: 0, lapses: 0, audio_urls: vec![],
        };
        vocab::schedule(&mut it, 4, 0);
        assert_eq!((it.reps, it.interval_days), (1, 1.0));
        vocab::schedule(&mut it, 4, 0);
        assert_eq!((it.reps, it.interval_days), (2, 6.0));
        vocab::schedule(&mut it, 5, 0);
        assert_eq!(it.reps, 3);
        assert!(it.interval_days >= 15.0);
        vocab::schedule(&mut it, 1, 0); // 忘記 → 重來、10 分鐘後
        assert_eq!((it.reps, it.lapses, it.due_at), (0, 1, 600_000));
        assert!(it.ease >= 1.3);
    }

    #[test]
    fn dict_lookup_lemma() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/ecdict.db");
        let conn = db::open_dict(std::path::Path::new(path)).unwrap();
        let r = dict::lookup_in(&conn, "Running,").unwrap();
        assert_eq!(r.entry.unwrap().word, "running");
        assert_eq!(r.lemma.unwrap().word, "run");
        let r = dict::lookup_in(&conn, "I’m").unwrap();
        assert!(r.entry.is_some(), "彎引號應正規化");
        let r = dict::lookup_in(&conn, "zzzqqqxx").unwrap();
        assert!(r.entry.is_none());
    }

    #[test]
    fn word_rank_family() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/ecdict.db");
        let conn = db::open_dict(std::path::Path::new(path)).unwrap();
        let (lemma, rank) = levels::lemma_and_rank(&conn, "running").unwrap();
        assert_eq!(lemma, "run");
        let (_, run_rank) = levels::lemma_and_rank(&conn, "run").unwrap();
        assert_eq!(rank, run_rank, "變化形與原形同一個家族排名");
        assert!(rank.unwrap() < 1500, "run 是基礎字");
        let (_, gonna) = levels::lemma_and_rank(&conn, "gonna").unwrap();
        assert!(gonna.unwrap() < 1500, "口語字 gonna 要排在前面");
        let (_, circadian) = levels::lemma_and_rank(&conn, "circadian").unwrap();
        assert!(circadian.unwrap() > 10_000);
        let (_, none) = levels::lemma_and_rank(&conn, "suprachiasmatic").unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn extract_json() {
        let v = claude::extract_json_array("```json\n[{\"i\":1,\"zh\":\"你好\"}]\n```").unwrap();
        assert_eq!(v[0]["zh"], "你好");
    }
}
