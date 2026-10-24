// 離線字典檔（ecdict.db）的尋找、狀態與下載。
// 安裝版會內建；單獨拿 exe 或檔案遺失時，App 照樣開，學習中心「字典」畫面可一鍵從 GitHub Release 下載。
use crate::db::{self, err, Dict};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

/// 目前載入的字典檔位置
pub struct DictPath(pub Mutex<Option<PathBuf>>);

// 下載位置與檢查碼：tools/package-dict.mjs 產生，編進執行檔（檢查碼跟著 App 版本走）
#[derive(Deserialize, Default)]
struct Manifest {
    url: String,
    sha256: String,
    size: u64,
}

fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../dict-manifest.json")).unwrap_or_default()
}

// 開發測試用：BOOKEN_DICT_URL 可改下載位置（例如本機伺服器）；檔案仍須符合 manifest 的 sha256
fn download_url() -> String {
    match std::env::var("BOOKEN_DICT_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => manifest().url,
    }
}

// 依序：安裝版內建 → exe 旁的 resources → App 資料夾（下載的放這裡，一定可寫）
fn candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = app.path().resolve("resources/ecdict.db", BaseDirectory::Resource) {
        out.push(p);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        out.push(dir.join("resources").join("ecdict.db"));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        out.push(dir.join("ecdict.db"));
    }
    out
}

pub fn open_any(app: &AppHandle) -> (Option<rusqlite::Connection>, Option<PathBuf>) {
    for p in candidates(app) {
        if p.exists() {
            if let Ok(conn) = db::open_dict(&p) {
                return (Some(conn), Some(p));
            }
        }
    }
    (None, None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub has_freq: bool,
    pub has_examples: bool,
    pub download_url: String,
    pub download_size: u64,
}

#[tauri::command]
pub fn dict_status(dict: State<'_, Dict>, path: State<'_, DictPath>) -> Result<DictStatus, String> {
    let guard = dict.0.lock().map_err(err)?;
    let conn = guard.as_ref();
    Ok(DictStatus {
        installed: conn.is_some(),
        path: path.0.lock().map_err(err)?.as_ref().map(|p| p.to_string_lossy().to_string()),
        has_freq: conn.is_some_and(|c| db::table_exists(c, "lemma_rank")),
        has_examples: conn.is_some_and(|c| db::table_exists(c, "examples")),
        download_url: download_url(),
        download_size: manifest().size,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str, // download / verify / extract / done
    received: u64,
    total: u64,
}

// 下載 ecdict.db.gz → 檢查 sha256 → 解壓 → 驗證是字典 → 換上去（不用重開 App）
#[tauri::command]
pub async fn dict_download(app: AppHandle) -> Result<String, String> {
    let url = download_url();
    if url.is_empty() {
        return Err("no-download-url".into());
    }
    let expected = manifest();
    let dir = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let gz_path = dir.join("ecdict.db.gz.part");

    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(err)?;
    let mut res = client.get(&url).send().await.map_err(|e| format!("download-failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download-failed: HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(expected.size);
    let mut file = std::fs::File::create(&gz_path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("download-failed: {e}"))? {
        file.write_all(&chunk).map_err(err)?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = app.emit("dict-progress", Progress { stage: "download", received, total });
        }
    }
    drop(file);

    let _ = app.emit("dict-progress", Progress { stage: "verify", received, total });
    let sha = format!("{:x}", hasher.finalize());
    if !expected.sha256.is_empty() && sha != expected.sha256 {
        let _ = std::fs::remove_file(&gz_path);
        return Err("checksum-mismatch".into());
    }

    let _ = app.emit("dict-progress", Progress { stage: "extract", received, total });
    let tmp = dir.join("ecdict.db.tmp");
    let (gz, tmp2) = (gz_path.clone(), tmp.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut input = flate2::read::GzDecoder::new(std::fs::File::open(&gz).map_err(err)?);
        let mut output = std::fs::File::create(&tmp2).map_err(err)?;
        std::io::copy(&mut input, &mut output).map_err(|e| format!("extract-failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(err)??;
    let _ = std::fs::remove_file(&gz_path);
    db::open_dict(&tmp).map_err(|e| format!("invalid-dict: {e}"))?; // 確認解出來的是字典

    // 換上：先放掉舊連線（Windows 開著的檔案不能被取代），再改名、重新開啟
    let target = dir.join("ecdict.db");
    let dict = app.state::<Dict>();
    let mut guard = dict.0.lock().map_err(err)?;
    *guard = None;
    if target.exists() {
        std::fs::remove_file(&target).map_err(err)?;
    }
    std::fs::rename(&tmp, &target).map_err(err)?;
    *guard = Some(db::open_dict(&target).map_err(err)?);
    drop(guard);
    *app.state::<DictPath>().0.lock().map_err(err)? = Some(target.clone());

    let _ = app.emit("dict-progress", Progress { stage: "done", received, total });
    // YouTube 頁重新載入，讓查字 / 分級立即生效
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval("location.reload()");
    }
    Ok(target.to_string_lossy().to_string())
}
