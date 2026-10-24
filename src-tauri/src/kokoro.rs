// Kokoro 離線自然語音（Apache-2.0，hexgrad/Kokoro-82M 的 ONNX fp16 版）。使用者在設定裡選用才下載（約 181 MB）。
// 流程：英文 → 音標（g2p.rs，misaki 詞典）→ token → ONNX Runtime 跑模型 → 24 kHz 音訊 → WAV（存快取）。
// fp16 版偶爾整段輸出 NaN（同一句、同一個聲音固定會），把速度微調 ±3% 重算就好（PLAN.md 4.8）。
use crate::db::err;
#[cfg(feature = "kokoro")]
use crate::g2p::{self, Lexicon};
#[cfg(feature = "kokoro")]
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "kokoro")]
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const SAMPLE_RATE: u32 = 24_000;
#[cfg(feature = "kokoro")]
const MAX_TOKENS: usize = 500; // 模型上限 510，留一點空間
const CACHE_LIMIT: u64 = 200 * 1024 * 1024;
#[cfg(feature = "kokoro")]
const SPEED_RETRIES: [f32; 4] = [1.0, 0.97, 1.03, 0.94];

#[derive(Deserialize, Clone)]
struct ManifestFile {
    path: String,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Deserialize)]
struct Manifest {
    files: Vec<ManifestFile>,
}

fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../kokoro-manifest.json")).unwrap_or(Manifest { files: vec![] })
}

#[cfg(feature = "kokoro")]
fn vocab() -> HashMap<char, i64> {
    let raw: HashMap<String, i64> = serde_json::from_str(include_str!("../kokoro-vocab.json")).unwrap_or_default();
    raw.into_iter().filter_map(|(k, v)| k.chars().next().map(|c| (c, v))).collect()
}

/// 下載位置：使用者資料夾的 kokoro\（預設 App 資料夾，和下載的離線字典同一個地方）
pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.state::<crate::db::DataDir>().0.join("kokoro"))
}

#[cfg(feature = "kokoro")]
struct Engine {
    session: Session,
    us: Lexicon,
    gb: Lexicon,
    vocab: HashMap<char, i64>,
    voices: HashMap<String, Vec<f32>>,
}

#[cfg(feature = "kokoro")]
type Loaded = Engine;
#[cfg(not(feature = "kokoro"))]
type Loaded = ();

/// 第一次念的時候才載入（模型約 160 MB、詞典約 13 MB）
#[derive(Default)]
pub struct Kokoro(Mutex<Option<Loaded>>);

#[cfg(feature = "kokoro")]
fn load(dir: &Path) -> Result<Engine, String> {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).map_err(|e| format!("tts-missing: {name}: {e}"));
    let us = Lexicon::from_json(&[&read("us_gold.json")?, &read("us_silver.json")?])?;
    let gb = Lexicon::from_json(&[&read("gb_gold.json")?, &read("gb_silver.json")?])?;
    let threads = std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4);
    let session = Session::builder()
        .map_err(err)?
        .with_intra_threads(threads)
        .map_err(err)?
        .commit_from_file(dir.join("model_fp16.onnx"))
        .map_err(|e| format!("tts-load-failed: {e}"))?;
    Ok(Engine { session, us, gb, vocab: vocab(), voices: HashMap::new() })
}

#[cfg(feature = "kokoro")]
impl Engine {
    fn voice(&mut self, dir: &Path, name: &str) -> Result<&Vec<f32>, String> {
        if !self.voices.contains_key(name) {
            let bytes = std::fs::read(dir.join("voices").join(format!("{name}.bin")))
                .map_err(|_| format!("tts-missing: voices/{name}.bin"))?;
            let v: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            self.voices.insert(name.to_string(), v);
        }
        Ok(&self.voices[name])
    }

    fn run(&mut self, ids: &[i64], style: Vec<f32>, speed: f32) -> Result<Vec<f32>, String> {
        let mut input = Vec::with_capacity(ids.len() + 2);
        input.push(0);
        input.extend_from_slice(ids);
        input.push(0);
        for factor in SPEED_RETRIES {
            let outputs = self
                .session
                .run(ort::inputs![
                    "input_ids" => Tensor::from_array(([1usize, input.len()], input.clone())).map_err(err)?,
                    "style" => Tensor::from_array(([1usize, 256], style.clone())).map_err(err)?,
                    "speed" => Tensor::from_array(([1usize], vec![speed * factor])).map_err(err)?,
                ])
                .map_err(|e| format!("tts-failed: {e}"))?;
            let (_, data) = outputs["waveform"].try_extract_tensor::<f32>().map_err(err)?;
            if !data.iter().any(|x| x.is_nan()) {
                return Ok(data.to_vec());
            }
        }
        Err("tts-failed: NaN".into())
    }

    fn speak(&mut self, dir: &Path, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>, String> {
        let british = voice.starts_with('b');
        let (phonemes, _) = g2p::phonemize(if british { &self.gb } else { &self.us }, text);
        let mut audio = Vec::new();
        for part in g2p::chunks(&phonemes, MAX_TOKENS) {
            let ids = g2p::tokens(&self.vocab, &part);
            if ids.is_empty() {
                continue;
            }
            // 聲音檔是 [510, 256]：依 token 數挑那一列
            let table = self.voice(dir, voice)?;
            let row = ids.len().min(table.len() / 256 - 1);
            let style = table[row * 256..row * 256 + 256].to_vec();
            let wav = self.run(&ids, style, speed)?;
            if !audio.is_empty() {
                audio.extend(std::iter::repeat(0.0).take(SAMPLE_RATE as usize / 8)); // 段落之間停 0.125 秒
            }
            audio.extend(wav);
        }
        Ok(audio)
    }
}

fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    b.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

fn valid_voice(v: &str) -> bool {
    v.len() <= 32 && v.contains('_') && v.chars().all(|c| c.is_ascii_lowercase() || c == '_')
}

/// 快取：同一句、同一個聲音、同一個速度只算一次。超過上限刪最舊的
fn cache_file(dir: &Path, text: &str, voice: &str, speed: f32) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(format!("{voice}|{speed:.2}|{text}").as_bytes()));
    dir.join("cache").join(format!("{}.wav", &key[..32]))
}

fn trim_cache(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir.join("cache")) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(feature = "kokoro")]
fn synthesize(app: &AppHandle, dir: &Path, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>, String> {
    let state = app.state::<Kokoro>();
    let mut guard = state.0.lock().map_err(err)?;
    if guard.is_none() {
        *guard = Some(load(dir)?);
    }
    guard.as_mut().unwrap().speak(dir, text, voice, speed)
}

#[cfg(not(feature = "kokoro"))]
fn synthesize(_: &AppHandle, _: &Path, _: &str, _: &str, _: f32) -> Result<Vec<f32>, String> {
    Err("tts-unsupported".into())
}

/// 念一段英文，回傳 WAV（畫面用 <audio> 播）
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    voice: String,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 2000 || !valid_voice(&voice) {
        return Err("invalid-input".into());
    }
    let speed = speed.clamp(0.5, 2.0);
    let dir = dir(&app)?;
    let cached = cache_file(&dir, &text, &voice, speed);
    if let Ok(bytes) = std::fs::read(&cached) {
        return Ok(tauri::ipc::Response::new(bytes));
    }
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let samples = synthesize(&app2, &dir, &text, &voice, speed)?;
        let bytes = wav_bytes(&samples);
        if std::fs::create_dir_all(cached.parent().unwrap()).is_ok() && std::fs::write(&cached, &bytes).is_ok() {
            trim_cache(&dir);
        }
        Ok(bytes)
    })
    .await
    .map_err(err)??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    pub supported: bool, // 這個平台的版本有沒有 Kokoro（Intel Mac 沒有）
    pub installed: bool,
    pub dir: String,
    pub download_size: u64, // 還要下載多少（全部裝好為 0）
    pub total_size: u64,
    pub disk_size: u64, // 實際占用（含快取）
}

fn file_ok(dir: &Path, f: &ManifestFile) -> bool {
    std::fs::metadata(dir.join(&f.path)).map(|m| m.len() == f.size).unwrap_or(false)
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

#[tauri::command]
pub fn tts_status(app: AppHandle) -> Result<TtsStatus, String> {
    let dir = dir(&app)?;
    let files = manifest().files;
    let missing: u64 = files.iter().filter(|f| !file_ok(&dir, f)).map(|f| f.size).sum();
    Ok(TtsStatus {
        supported: cfg!(feature = "kokoro"),
        installed: missing == 0 && !files.is_empty(),
        dir: dir.to_string_lossy().to_string(),
        download_size: missing,
        total_size: files.iter().map(|f| f.size).sum(),
        disk_size: dir_size(&dir),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    file: String,
    received: u64, // 全部檔案累計
    total: u64,
    stage: &'static str, // download / done
}

/// 下載缺少的檔案：每個檔案比對 sha256 才放進去（已經有、大小正確的跳過）
#[tauri::command]
pub async fn tts_download(app: AppHandle) -> Result<String, String> {
    if !cfg!(feature = "kokoro") {
        return Err("tts-unsupported".into());
    }
    let dir = dir(&app)?;
    std::fs::create_dir_all(dir.join("voices")).map_err(err)?;
    let files: Vec<ManifestFile> = manifest().files.into_iter().filter(|f| !file_ok(&dir, f)).collect();
    let total: u64 = files.iter().map(|f| f.size).sum();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("book-en (https://github.com/craig7351/book-en)")
        .build()
        .map_err(err)?;
    let mut received: u64 = 0;
    let mut last = Instant::now();
    for f in &files {
        let target = dir.join(&f.path);
        let part = target.with_extension("part");
        let mut res = client.get(&f.url).send().await.map_err(|e| format!("download-failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("download-failed: HTTP {} ({})", res.status().as_u16(), f.path));
        }
        let mut file = std::fs::File::create(&part).map_err(err)?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("download-failed: {e}"))? {
            file.write_all(&chunk).map_err(err)?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            if last.elapsed() > Duration::from_millis(150) {
                last = Instant::now();
                let _ = app.emit("tts-progress", Progress { file: f.path.clone(), received, total, stage: "download" });
            }
        }
        drop(file);
        if format!("{:x}", hasher.finalize()) != f.sha256 {
            let _ = std::fs::remove_file(&part);
            return Err(format!("checksum-mismatch: {}", f.path));
        }
        if target.exists() {
            std::fs::remove_file(&target).map_err(err)?;
        }
        std::fs::rename(&part, &target).map_err(err)?;
    }
    let _ = app.emit("tts-progress", Progress { file: String::new(), received, total, stage: "done" });
    Ok(dir.to_string_lossy().to_string())
}

/// 不用了：釋放模型、刪掉整個 kokoro 資料夾（含快取）
#[tauri::command]
pub fn tts_remove(app: AppHandle, state: State<'_, Kokoro>) -> Result<(), String> {
    *state.0.lock().map_err(err)? = None;
    let dir = dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "kokoro")]
    #[test]
    fn manifest_and_vocab_are_valid() {
        let m = manifest();
        assert_eq!(m.files.len(), 15);
        assert!(m.files.iter().all(|f| f.sha256.len() == 64 && f.size > 0 && f.url.starts_with("https://")));
        assert!(m.files.iter().any(|f| f.path == "model_fp16.onnx"));
        let v = vocab();
        assert!(v.len() > 100 && v.contains_key(&'ˈ') && v.contains_key(&'ɐ'));
    }

    #[test]
    fn wav_header() {
        let b = wav_bytes(&[0.0, 1.0, -1.0]);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(b.len(), 44 + 6);
        assert_eq!(i16::from_le_bytes([b[46], b[47]]), 32767);
    }

    /// 需要真的模型：KOKORO_TEST_DIR=<下載資料夾> cargo test -- --ignored real_model
    #[cfg(feature = "kokoro")]
    #[test]
    #[ignore]
    fn real_model() {
        let dir = PathBuf::from(std::env::var("KOKORO_TEST_DIR").expect("KOKORO_TEST_DIR"));
        let t = Instant::now();
        let mut e = load(&dir).unwrap();
        println!("load {:?}", t.elapsed());
        for (voice, text) in [
            ("af_heart", "Practice makes perfect, so keep listening every day."),
            ("bf_emma", "The circadian rhythms of the hypothalamus regulate when we feel sleepy."),
            ("am_michael", "In 1999, I visited 3 cities and watched TV with my 2nd cousin."),
        ] {
            let t = Instant::now();
            let a = e.speak(&dir, text, voice, 1.0).unwrap();
            let secs = a.len() as f32 / SAMPLE_RATE as f32;
            println!("{voice}: {secs:.2}s audio in {:?} | {}", t.elapsed(), g2p::phonemize(if voice.starts_with('b') { &e.gb } else { &e.us }, text).0);
            assert!(secs > 1.0 && a.iter().all(|x| x.is_finite()));
            assert!(a.iter().any(|x| x.abs() > 0.05), "should not be silent");
        }
    }

    #[test]
    fn voice_names() {
        assert!(valid_voice("af_heart"));
        assert!(!valid_voice("../x"));
        assert!(!valid_voice("AF"));
    }
}
