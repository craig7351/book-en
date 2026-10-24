// 英文文字 → Kokoro 用的音標（G2P）。
// 用 Kokoro 作者的 misaki 詞典（Apache-2.0）查字＋規則，不用 eSpeak NG（GPL-3.0，會影響 App 的授權）。
// 在 App 的 52,841 句例句上，只靠詞典查不到的字約 0.72%（縮寫、-ies 複數、've、人名…），下面的規則補掉大部分。
use std::collections::HashMap;

pub struct Lexicon {
    words: HashMap<String, String>,
}

impl Lexicon {
    /// misaki 的 gold / silver 詞典（JSON：字 → 音標，或 字 → {詞性: 音標}）；前面的優先
    pub fn from_json(sources: &[&str]) -> Result<Lexicon, String> {
        let mut words = HashMap::new();
        for src in sources.iter().rev() {
            let map: HashMap<String, serde_json::Value> = serde_json::from_str(src).map_err(|e| e.to_string())?;
            for (k, v) in map {
                let p = match &v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    // 多音字（read、live…）先用預設讀音
                    serde_json::Value::Object(o) => o
                        .get("DEFAULT")
                        .or_else(|| o.values().next())
                        .and_then(|x| x.as_str())
                        .map(str::to_string),
                    _ => None,
                };
                if let Some(p) = p {
                    words.insert(k, p);
                }
            }
        }
        Ok(Lexicon { words })
    }

    #[cfg(test)]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Lexicon {
        Lexicon { words: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    fn get(&self, w: &str) -> Option<String> {
        if let Some(p) = self.words.get(w) {
            return Some(p.clone());
        }
        let lower = w.to_lowercase();
        if let Some(p) = self.words.get(&lower) {
            return Some(p.clone());
        }
        // 句首大寫：Hello → hello 已處理；全小寫的專有名詞 → 試首字大寫
        let mut cap = lower.clone();
        if let Some(f) = cap.get_mut(0..1) {
            f.make_ascii_uppercase();
        }
        self.words.get(&cap).cloned()
    }

    /// 單字（不含標點）→ 音標
    pub fn word(&self, w: &str) -> Option<String> {
        if let Some(p) = self.get(w) {
            return Some(p);
        }
        let lower = w.to_lowercase();
        // 縮寫 TV / USA：逐字母念
        if w.len() >= 2 && w.len() <= 5 && w.chars().all(|c| c.is_ascii_uppercase()) {
            let letters: Option<Vec<String>> = w.chars().map(|c| self.get(&c.to_string())).collect();
            if let Some(l) = letters {
                return Some(l.join(""));
            }
        }
        // 縮寫字尾：should've、what're、they'll、I'd
        for (suf, add) in [("'ve", "v"), ("'re", "ɹ"), ("'ll", "l"), ("'d", "d"), ("'m", "m")] {
            if let Some(stem) = lower.strip_suffix(suf) {
                if let Some(p) = self.get(stem) {
                    return Some(p + add);
                }
            }
        }
        // 所有格
        for suf in ["'s", "s'"] {
            if let Some(stem) = lower.strip_suffix(suf) {
                if let Some(p) = self.word(stem) {
                    return Some(plural(&p));
                }
            }
        }
        if lower.ends_with('\'') {
            return self.word(&lower[..lower.len() - 1]);
        }
        // 字尾變化：cities、boxes、stopped、running、making
        if let Some(p) = self.inflected(&lower) {
            return Some(p);
        }
        // 連字號：well-known
        if lower.contains('-') {
            let parts: Option<Vec<String>> = lower.split('-').filter(|s| !s.is_empty()).map(|s| self.word(s)).collect();
            if let Some(p) = parts {
                return Some(p.join(" "));
            }
        }
        // 複合字：cellphone = cell + phone
        let chars: Vec<char> = lower.chars().collect();
        for i in 3..chars.len().saturating_sub(2) {
            let (a, b): (String, String) = (chars[..i].iter().collect(), chars[i..].iter().collect());
            if let (Some(pa), Some(pb)) = (self.get(&a), self.get(&b)) {
                return Some(pa + &pb);
            }
        }
        None
    }

    fn inflected(&self, w: &str) -> Option<String> {
        let stem = |s: &str| self.get(s);
        if let Some(s) = w.strip_suffix("ies") {
            if let Some(p) = stem(&format!("{s}y")) {
                return Some(plural(&p));
            }
        }
        if let Some(s) = w.strip_suffix("es") {
            if s.ends_with(['s', 'x', 'z']) || s.ends_with("ch") || s.ends_with("sh") {
                if let Some(p) = stem(s) {
                    return Some(p + "ᵻz");
                }
            }
        }
        if let Some(s) = w.strip_suffix('s') {
            if let Some(p) = stem(s) {
                return Some(plural(&p));
            }
        }
        if let Some(s) = w.strip_suffix("ied") {
            if let Some(p) = stem(&format!("{s}y")) {
                return Some(p + "d");
            }
        }
        if let Some(s) = w.strip_suffix("ed") {
            for cand in [s.to_string(), format!("{s}e"), undouble(s)] {
                if let Some(p) = stem(&cand) {
                    return Some(past(&p));
                }
            }
        }
        if let Some(s) = w.strip_suffix("ing") {
            for cand in [s.to_string(), format!("{s}e"), undouble(s)] {
                if let Some(p) = stem(&cand) {
                    return Some(p + "ɪŋ");
                }
            }
        }
        if let Some(s) = w.strip_suffix("ly") {
            if let Some(p) = stem(s) {
                return Some(p + "li");
            }
        }
        None
    }
}

fn undouble(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 2 && b[b.len() - 1] == b[b.len() - 2] {
        s[..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

const VOICELESS: [char; 5] = ['p', 't', 'k', 'f', 'θ'];

fn plural(p: &str) -> String {
    let last = p.chars().last().unwrap_or(' ');
    if matches!(last, 's' | 'z' | 'ʃ' | 'ʒ' | 'ʧ' | 'ʤ') {
        format!("{p}ᵻz")
    } else if VOICELESS.contains(&last) {
        format!("{p}s")
    } else {
        format!("{p}z")
    }
}

fn past(p: &str) -> String {
    let last = p.chars().last().unwrap_or(' ');
    if matches!(last, 't' | 'd') {
        format!("{p}ᵻd")
    } else if VOICELESS.contains(&last) || matches!(last, 's' | 'ʃ' | 'ʧ') {
        format!("{p}t")
    } else {
        format!("{p}d")
    }
}

// ---- 數字 ----

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

pub fn number_words(n: u64) -> Vec<String> {
    let mut out = Vec::new();
    fn below_1000(n: u64, out: &mut Vec<String>) {
        if n >= 100 {
            out.push(ONES[(n / 100) as usize].into());
            out.push("hundred".into());
            if n % 100 == 0 {
                return;
            }
        }
        let r = n % 100;
        if r < 20 {
            out.push(ONES[r as usize].into());
        } else {
            out.push(TENS[(r / 10) as usize].into());
            if r % 10 != 0 {
                out.push(ONES[(r % 10) as usize].into());
            }
        }
    }
    if n == 0 {
        return vec!["zero".into()];
    }
    // 年份 1100–1999、2010–2099：nineteen ninety-nine
    if (1100..2000).contains(&n) || (2010..2100).contains(&n) {
        below_1000(n / 100, &mut out);
        if n % 100 == 0 {
            out.push("hundred".into());
        } else if n % 100 < 10 {
            out.push("oh".into());
            out.push(ONES[(n % 10) as usize].into());
        } else {
            below_1000(n % 100, &mut out);
        }
        return out;
    }
    for (unit, name) in [(1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")] {
        if (n / unit) % 1000 > 0 {
            below_1000((n / unit) % 1000, &mut out);
            out.push(name.into());
        }
    }
    if n % 1000 != 0 || out.is_empty() {
        below_1000(n % 1000, &mut out);
    }
    out
}

fn ordinal(words: &mut [String]) {
    if let Some(last) = words.last_mut() {
        *last = match last.as_str() {
            "one" => "first".into(),
            "two" => "second".into(),
            "three" => "third".into(),
            "five" => "fifth".into(),
            "eight" => "eighth".into(),
            "nine" => "ninth".into(),
            "twelve" => "twelfth".into(),
            w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
            w => format!("{w}th"),
        };
    }
}

// ---- 整句 ----

enum Tok {
    Word(String),
    Punct(char),
}

fn tokenize(text: &str) -> Vec<Tok> {
    let text = text.replace(['’', '‘'], "'");
    let mut out = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<Tok>| {
        let w = cur.trim_matches(|c: char| c == '\'' || c == '-').to_string();
        if !w.is_empty() {
            out.push(Tok::Word(w));
        }
        cur.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '\'' || (c == '-' && !cur.is_empty()) {
            cur.push(c);
        } else {
            flush(&mut cur, &mut out);
            match c {
                '.' | ',' | '!' | '?' | ';' | ':' => out.push(Tok::Punct(c)),
                '—' | '–' => out.push(Tok::Punct('—')),
                '…' => out.push(Tok::Punct('…')),
                _ => {}
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// 把數字展開成英文字（12 → twelve、5th → fifth、1,000 → one thousand）
fn expand_numbers(toks: Vec<Tok>) -> Vec<Tok> {
    let mut out = Vec::new();
    for t in toks {
        match t {
            Tok::Word(w) if w.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
                let digits: String = w.chars().take_while(|c| c.is_ascii_digit()).collect();
                let rest = w[digits.len()..].to_lowercase();
                match digits.parse::<u64>() {
                    Ok(n) if n < 1_000_000_000_000 => {
                        let mut words = number_words(n);
                        if matches!(rest.as_str(), "st" | "nd" | "rd" | "th") {
                            ordinal(&mut words);
                        } else if rest == "s" {
                            // 1990s
                            if let Some(l) = words.last_mut() {
                                *l = if l.ends_with('y') { format!("{}ies", &l[..l.len() - 1]) } else { format!("{l}s") };
                            }
                        } else if !rest.is_empty() {
                            words.push(rest);
                        }
                        out.extend(words.into_iter().map(Tok::Word));
                    }
                    _ => out.push(Tok::Word(w)),
                }
            }
            t => out.push(t),
        }
    }
    out
}

const VOWELS: [char; 5] = ['a', 'e', 'i', 'o', 'u'];

/// 一句英文 → 音標字串（字之間空白，標點黏在前一個字後面）。回傳 (音標, 查不到的字)
pub fn phonemize(lex: &Lexicon, text: &str) -> (String, Vec<String>) {
    let toks = expand_numbers(tokenize(text));
    let mut out = String::new();
    let mut missing = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        match t {
            Tok::Punct(c) => out.push(*c),
            Tok::Word(w) => {
                let next_vowel = toks[i + 1..]
                    .iter()
                    .find_map(|t| if let Tok::Word(n) = t { Some(n.to_lowercase().starts_with(VOWELS)) } else { None })
                    .unwrap_or(false);
                let p = match w.as_str() {
                    "a" | "A" if !(w == "A" && matches!(toks.get(i + 1), Some(Tok::Punct('.')))) => Some("ɐ".to_string()),
                    "the" | "The" | "THE" => Some(if next_vowel { "ði" } else { "ðə" }.to_string()),
                    _ => lex.word(w),
                };
                let p = p.unwrap_or_else(|| {
                    missing.push(w.clone());
                    spell_out(w)
                });
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&p);
            }
        }
    }
    (out.trim().to_string(), missing)
}

/// 詞典查不到（多半是人名）：用簡單的拼讀規則猜
fn spell_out(w: &str) -> String {
    let w = w.to_lowercase();
    let b: Vec<char> = w.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut stressed = false;
    while i < b.len() {
        let two: String = b[i..(i + 2).min(b.len())].iter().collect();
        let (p, n) = match two.as_str() {
            "th" => ("θ", 2),
            "sh" => ("ʃ", 2),
            "ch" => ("ʧ", 2),
            "ph" => ("f", 2),
            "ng" => ("ŋ", 2),
            "ck" => ("k", 2),
            "ee" | "ea" => ("i", 2),
            "oo" => ("u", 2),
            "ai" | "ay" => ("A", 2),
            "ou" | "ow" => ("W", 2),
            "oa" => ("O", 2),
            _ => (
                match b[i] {
                    'a' => "æ",
                    'e' => "ɛ",
                    'i' => "ɪ",
                    'o' => "ɑ",
                    'u' => "ʌ",
                    'y' if i > 0 => "i",
                    'y' => "j",
                    'c' => "k",
                    'q' => "k",
                    'x' => "ks",
                    'j' => "ʤ",
                    'r' => "ɹ",
                    'g' => "ɡ",
                    c if c.is_ascii_alphabetic() => {
                        out.push(c);
                        i += 1;
                        continue;
                    }
                    _ => "",
                },
                1,
            ),
        };
        // 第一個母音加重音
        if !stressed && p.chars().next().is_some_and(|c| "æɛɪɑʌiuAWO".contains(c)) {
            out.push('ˈ');
            stressed = true;
        }
        out.push_str(p);
        i += n;
    }
    out
}

/// 音標 → token id（vocab 裡沒有的字元略過）
pub fn tokens(vocab: &HashMap<char, i64>, phonemes: &str) -> Vec<i64> {
    phonemes.chars().filter_map(|c| vocab.get(&c).copied()).collect()
}

/// 太長的音標依句末標點切段（模型一次最多 510 個 token）
pub fn chunks(phonemes: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for piece in phonemes.split_inclusive(['.', '!', '?', ';', ',', '—']) {
        if cur.chars().count() + piece.chars().count() > max && !cur.is_empty() {
            out.push(cur.trim().to_string());
            cur.clear();
        }
        if piece.chars().count() > max {
            // 沒有標點的超長段：照空白硬切
            for w in piece.split(' ') {
                if cur.chars().count() + w.chars().count() + 1 > max && !cur.is_empty() {
                    out.push(cur.trim().to_string());
                    cur.clear();
                }
                cur.push_str(w);
                cur.push(' ');
            }
        } else {
            cur.push_str(piece);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex() -> Lexicon {
        Lexicon::from_pairs(&[
            ("city", "sˈɪti"),
            ("box", "bˈɑks"),
            ("stop", "stˈɑp"),
            ("run", "ɹˈʌn"),
            ("make", "mˈAk"),
            ("should", "ʃˌʊd"),
            ("cell", "sˈɛl"),
            ("phone", "fˈOn"),
            ("T", "tˈi"),
            ("V", "vˈi"),
            ("I", "ˈI"),
            ("apple", "ˈæpəl"),
            ("cat", "kˈæt"),
            ("dog", "dˈɔɡ"),
            ("hello", "həlˈO"),
            ("twenty", "twˈɛnti"),
            ("one", "wˈʌn"),
            ("fifth", "fˈɪfθ"),
        ])
    }

    #[test]
    fn inflections_and_rules() {
        let l = lex();
        assert_eq!(l.word("cities").as_deref(), Some("sˈɪtiz"));
        assert_eq!(l.word("boxes").as_deref(), Some("bˈɑksᵻz"));
        assert_eq!(l.word("stopped").as_deref(), Some("stˈɑpt"));
        assert_eq!(l.word("running").as_deref(), Some("ɹˈʌnɪŋ"));
        assert_eq!(l.word("making").as_deref(), Some("mˈAkɪŋ"));
        assert_eq!(l.word("should've").as_deref(), Some("ʃˌʊdv"));
        assert_eq!(l.word("cellphone").as_deref(), Some("sˈɛlfˈOn"));
        assert_eq!(l.word("TV").as_deref(), Some("tˈivˈi"));
        assert_eq!(l.word("Hello").as_deref(), Some("həlˈO"));
        assert_eq!(l.word("cats").as_deref(), Some("kˈæts"));
        assert_eq!(l.word("dogs").as_deref(), Some("dˈɔɡz"));
    }

    #[test]
    fn sentence_articles_and_punctuation() {
        let (p, missing) = phonemize(&lex(), "Hello, a cat and the apple!");
        assert!(p.starts_with("həlˈO, ɐ kˈæt"), "{p}");
        assert!(p.contains("ði ˈæpəl!"), "{p}");
        assert_eq!(missing, vec!["and"]);
    }

    #[test]
    fn numbers() {
        assert_eq!(number_words(21).join(" "), "twenty one");
        assert_eq!(number_words(1999).join(" "), "nineteen ninety nine");
        assert_eq!(number_words(2005).join(" "), "two thousand five");
        assert_eq!(number_words(1_250_000).join(" "), "one million two hundred fifty thousand");
        let (p, _) = phonemize(&lex(), "the 5th");
        assert!(p.ends_with("fˈɪfθ"), "{p}");
    }

    #[test]
    fn chunking() {
        let s = "a b c. d e f. g h i.";
        let c = chunks(s, 8);
        assert!(c.iter().all(|x| x.chars().count() <= 8), "{c:?}");
        assert_eq!(c.join(" "), s);
    }
}
