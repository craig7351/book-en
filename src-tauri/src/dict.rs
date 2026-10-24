// 查字典：離線 ECDICT（中文釋義、音標、詞形）+ 線上 dictionaryapi.dev（發音音檔、英英例句）。
use crate::db::{err, Dict, NO_DICT};
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
    let guard = dict.0.lock().map_err(err)?;
    let conn = guard.as_ref().ok_or(NO_DICT)?;
    lookup_in(conn, &word).map_err(err)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OnlineInfo {
    pub audio_url: Option<String>,
    /// 所有真人錄音（常見 -us / -uk / -au 結尾），畫面依口音設定挑
    pub audio_urls: Vec<String>,
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
    // dictionaryapi.dev 偶爾整個掛掉（Cloudflare 530）→ 改用 Datamuse（只有英英釋義、沒有音檔）
    let res = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) if r.status().as_u16() == 404 => return Ok(OnlineInfo::default()), // 真的查無此字
        _ => {
            let mut info = datamuse(&client, &word).await.unwrap_or_default();
            info.audio_urls = wiktionary_audio(&client, &word).await.unwrap_or_default();
            info.audio_url = info.audio_urls.first().cloned();
            return Ok(info);
        }
    };
    let data: serde_json::Value = res.json().await.map_err(err)?;
    let entries = data.as_array().cloned().unwrap_or_default();
    let mut info = OnlineInfo::default();
    for e in &entries {
        if info.phonetic.is_none() {
            info.phonetic = e["phonetic"].as_str().map(str::to_string);
        }
        for p in e["phonetics"].as_array().into_iter().flatten() {
            let audio = p["audio"].as_str().filter(|a| !a.is_empty()).map(|a| {
                if a.starts_with("//") { format!("https:{a}") } else { a.to_string() }
            });
            if let Some(a) = audio {
                if !info.audio_urls.contains(&a) {
                    info.audio_urls.push(a.clone());
                }
                info.audio_url.get_or_insert(a);
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
    // dictionaryapi.dev 的音檔主機也會掛掉 → 一律附上維基共享資源的錄音當備援（畫面依序試）
    for a in wiktionary_audio(&client, &word).await.unwrap_or_default() {
        if !info.audio_urls.contains(&a) {
            info.audio_urls.push(a);
        }
    }
    if info.audio_url.is_none() {
        info.audio_url = info.audio_urls.first().cloned();
    }
    Ok(info)
}

// 真人錄音的備援：維基詞典頁面上的英文發音檔（Wikimedia Commons，CC 授權；dictionaryapi.dev 的錄音也是來自這裡）。
// 檔名慣例 en-us-paper.ogg、En-uk-paper.ogg；Lingua Libre 的 LL-Q1860 (eng)-… 不知口音，排最後。
async fn wiktionary_audio(client: &reqwest::Client, word: &str) -> Option<Vec<String>> {
    let url = format!(
        "https://en.wiktionary.org/w/api.php?action=query&titles={word}&prop=images&imlimit=100&format=json&formatversion=2"
    );
    let data: serde_json::Value = client
        .get(url)
        .header("User-Agent", "book-en/0.1 (https://github.com/craig7351/book-en)")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let mut accented = Vec::new();
    let mut other = Vec::new();
    for img in data["query"]["pages"][0]["images"].as_array()? {
        let Some(name) = img["title"].as_str().and_then(|t| t.strip_prefix("File:")) else { continue };
        let lower = name.to_lowercase();
        let audio = [".ogg", ".oga", ".mp3", ".wav", ".flac"].iter().any(|e| lower.ends_with(e));
        if !audio {
            continue;
        }
        let file = format!("https://commons.wikimedia.org/wiki/Special:FilePath/{}", encode_file(name));
        if ["en-us-", "en-uk-", "en-gb-", "en-au-", "en-ca-", "en-nz-"].iter().any(|p| lower.starts_with(p)) {
            accented.push(file);
        } else if lower.starts_with("ll-q1860 ") {
            other.push(file);
        }
    }
    accented.extend(other);
    Some(accented)
}

fn encode_file(name: &str) -> String {
    name.replace(' ', "_")
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// 備援：Datamuse（https://www.datamuse.com/api/），defs 格式 "n\t定義"
async fn datamuse(client: &reqwest::Client, word: &str) -> Option<OnlineInfo> {
    let url = format!("https://api.datamuse.com/words?sp={word}&md=d&max=1");
    let data: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    let defs = data.get(0)?.get("defs")?.as_array()?.clone();
    let pos_name = |tag: &str| match tag {
        "n" => "noun",
        "v" => "verb",
        "adj" => "adjective",
        "adv" => "adverb",
        _ => "",
    };
    let senses = defs
        .iter()
        .filter_map(|d| {
            let (tag, def) = d.as_str()?.split_once('\t')?;
            Some(Sense { pos: pos_name(tag).to_string(), definition: def.trim().to_string(), example: None })
        })
        .take(4)
        .collect();
    Some(OnlineInfo { audio_url: None, audio_urls: Vec::new(), phonetic: None, senses })
}
