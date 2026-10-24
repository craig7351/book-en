// 遊戲模式（寵物養成）。預設關閉；關閉時不寫入任何遊戲資料。
// 規則：只有「到期的字」答對才讓寵物長大、孵蛋 → 想養寵物就得照間隔重複複習（PLAN.md 4.7）。
// 所有獎勵都在這裡算，畫面端只負責顯示。日期一律用畫面傳來的「使用者當地今天 0 點」（day）。
use crate::db::{err, now_ms, Db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const DAY: i64 = 86_400_000;
pub const MAX_LEVEL: i64 = 30;
pub const HATCH_WARMTH: i64 = 30;
pub const SPECIES: [&str; 4] = ["mochi", "pip", "nori", "drako"];
const MAX_FREEZES: i64 = 2;
const PRACTICE_XP_CAP: i64 = 30;
const COLLECT_COIN_CAP: i64 = 20;

fn default_name(species: &str) -> &'static str {
    match species {
        "mochi" => "麻糬",
        "pip" => "啾啾",
        "nori" => "煤球",
        _ => "小龍",
    }
}

/// 升到下一級需要的經驗：25 × 等級^1.2（每天約 200 經驗 → Lv.10 約 8 天、Lv.30 約 100 天）
pub fn xp_need(level: i64) -> i64 {
    (25.0 * (level as f64).powf(1.2)).round() as i64
}

pub fn stage_of(level: i64) -> i64 {
    match level {
        ..=9 => 1,
        10..=19 => 2,
        _ => 3,
    }
}

// ---- 商店目錄 ----

pub struct CatalogItem {
    pub id: &'static str,
    pub kind: &'static str, // accessory | scene | snack | freeze | egg
    pub slot: &'static str, // 配件位置：head / face / neck
    pub price: i64,
}

const fn acc(id: &'static str, slot: &'static str, price: i64) -> CatalogItem {
    CatalogItem { id, kind: "accessory", slot, price }
}
const fn scene(id: &'static str, price: i64) -> CatalogItem {
    CatalogItem { id, kind: "scene", slot: "", price }
}

pub const CATALOG: &[CatalogItem] = &[
    CatalogItem { id: "snack", kind: "snack", slot: "", price: 20 },
    CatalogItem { id: "freeze", kind: "freeze", slot: "", price: 60 },
    CatalogItem { id: "egg", kind: "egg", slot: "", price: 150 },
    acc("cap", "head", 40),
    acc("bow", "head", 40),
    acc("flower", "head", 40),
    acc("beanie", "head", 50),
    acc("headphones", "head", 80),
    acc("wizard", "head", 100),
    acc("crown", "head", 120),
    acc("glasses", "face", 60),
    acc("shades", "face", 80),
    acc("scarf", "neck", 50),
    scene("study", 100),
    scene("beach", 150),
    scene("forest", 150),
    scene("space", 200),
];

fn catalog(id: &str) -> Option<&'static CatalogItem> {
    CATALOG.iter().find(|c| c.id == id)
}

// ---- 選項（存在 settings 表的 game）----

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub enabled: bool,
    pub companion: bool, // YouTube 面板的迷你寵物
    pub sound: bool,     // 8-bit 音效
    pub scene: String,
    pub last_free_week: i64,
    pub settled_through: i64, // 連續天數已結算到哪一天（含）
}

impl Default for Options {
    fn default() -> Self {
        Options {
            enabled: false,
            companion: false,
            sound: false,
            scene: "room".into(),
            last_free_week: 0,
            settled_through: 0,
        }
    }
}

fn load_opts(conn: &Connection) -> Options {
    conn.query_row("SELECT value FROM settings WHERE key = 'game'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_opts(conn: &Connection, o: &Options) -> rusqlite::Result<()> {
    let json = serde_json::to_string(o).unwrap_or_default();
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('game', ?1)", [json])?;
    Ok(())
}

pub fn enabled(conn: &Connection) -> bool {
    load_opts(conn).enabled
}

// 畫面傳來的「今天 0 點」不合理（時鐘、時區異常）就退回 UTC 的今天
pub fn sane_day(day: Option<i64>, now: i64) -> i64 {
    match day {
        Some(d) if (now - d).abs() < 2 * DAY => d,
        _ => now - now.rem_euclid(DAY),
    }
}

fn week_of(day: i64) -> i64 {
    // 1970-01-01 是星期四；+3 天讓每週從星期一開始，+12 小時吸收時區差
    (day + 3 * DAY + DAY / 2).div_euclid(7 * DAY)
}

fn rand_u64() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    let mut x = nanos ^ 0x9E37_79B9_7F4A_7C15;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

// ---- 檢視用的資料 ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetView {
    pub id: i64,
    pub species: String,
    pub name: String,
    pub level: i64,
    pub xp: i64,
    pub need: i64,
    pub stage: i64,
    pub branch: Option<String>,
    pub shiny: bool,
    pub active: bool,
    pub accessories: Vec<String>,
    pub hatched_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EggView {
    pub id: i64,
    pub species: String,
    pub warmth: i64,
    pub need: i64,
    pub incubating: bool,
    pub source: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reward {
    pub xp: i64,
    pub coins: i64,
    pub level_up: Option<i64>,
    pub evolved: Option<String>, // teen / 成年分支
    pub hatched: Option<PetView>,
    pub egg: Option<EggView>, // 孵蛋進度（有蛋在孵時）
    pub pet: Option<PetView>, // 陪伴中的寵物（更新後）
    pub notes: Vec<String>,
}

const PET_COLS: &str = "id, species, name, level, xp, branch, shiny, active, accessories, hatched_at";

fn row_pet(r: &rusqlite::Row) -> rusqlite::Result<PetView> {
    let level: i64 = r.get(3)?;
    let acc: String = r.get(8)?;
    Ok(PetView {
        id: r.get(0)?,
        species: r.get(1)?,
        name: r.get(2)?,
        level,
        xp: r.get(4)?,
        need: if level >= MAX_LEVEL { 0 } else { xp_need(level) },
        stage: stage_of(level),
        branch: r.get(5)?,
        shiny: r.get::<_, i64>(6)? != 0,
        active: r.get::<_, i64>(7)? != 0,
        accessories: serde_json::from_str(&acc).unwrap_or_default(),
        hatched_at: r.get(9)?,
    })
}

fn row_egg(r: &rusqlite::Row) -> rusqlite::Result<EggView> {
    Ok(EggView {
        id: r.get(0)?,
        species: r.get(1)?,
        warmth: r.get(2)?,
        need: HATCH_WARMTH,
        incubating: r.get::<_, i64>(3)? != 0,
        source: r.get(4)?,
    })
}

fn pets(conn: &Connection) -> rusqlite::Result<Vec<PetView>> {
    let mut stmt = conn.prepare(&format!("SELECT {PET_COLS} FROM pets ORDER BY hatched_at"))?;
    let rows = stmt.query_map([], row_pet)?;
    rows.collect()
}

fn active_pet(conn: &Connection) -> rusqlite::Result<Option<PetView>> {
    conn.query_row(&format!("SELECT {PET_COLS} FROM pets WHERE active = 1"), [], row_pet).optional()
}

fn eggs(conn: &Connection) -> rusqlite::Result<Vec<EggView>> {
    let mut stmt = conn
        .prepare("SELECT id, species, warmth, incubating, source FROM eggs ORDER BY incubating DESC, obtained_at")?;
    let rows = stmt.query_map([], row_egg)?;
    rows.collect()
}

fn incubating_egg(conn: &Connection) -> rusqlite::Result<Option<EggView>> {
    let egg = conn
        .query_row("SELECT id, species, warmth, incubating, source FROM eggs WHERE incubating = 1", [], row_egg)
        .optional()?;
    if egg.is_some() {
        return Ok(egg);
    }
    // 沒有在孵的就自動孵最早拿到的那顆
    let id: Option<i64> =
        conn.query_row("SELECT id FROM eggs ORDER BY obtained_at LIMIT 1", [], |r| r.get(0)).optional()?;
    match id {
        Some(id) => {
            conn.execute("UPDATE eggs SET incubating = 1 WHERE id = ?1", [id])?;
            conn.query_row("SELECT id, species, warmth, incubating, source FROM eggs WHERE id = ?1", [id], row_egg)
                .optional()
        }
        None => Ok(None),
    }
}

pub fn coins(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE(SUM(amount), 0) FROM coin_log", [], |r| r.get(0))
}

fn add_coins(conn: &Connection, amount: i64, kind: &str, refv: Option<&str>, now: i64) -> rusqlite::Result<()> {
    if amount != 0 {
        conn.execute(
            "INSERT INTO coin_log(at, amount, kind, ref) VALUES (?1, ?2, ?3, ?4)",
            params![now, amount, kind, refv],
        )?;
    }
    Ok(())
}

fn qty(conn: &Connection, item: &str) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row("SELECT qty FROM inventory WHERE item = ?1", [item], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

fn add_item(conn: &Connection, item: &str, n: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO inventory(item, qty) VALUES (?1, ?2) ON CONFLICT(item) DO UPDATE SET qty = qty + ?2",
        params![item, n],
    )?;
    Ok(())
}

fn add_egg(conn: &Connection, species: &str, source: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO eggs(species, warmth, incubating, obtained_at, source) VALUES (?1, 0, 0, ?2, ?3)",
        params![species, now, source],
    )?;
    Ok(())
}

fn random_species() -> &'static str {
    SPECIES[(rand_u64() % SPECIES.len() as u64) as usize]
}

// ---- 每日紀錄與連續天數 ----

#[derive(Default)]
struct Daily {
    due_reviews: i64,
    practice: i64,
    practice_xp: i64,
    collect_coins: i64,
    all_due_done: bool,
    freeze_used: bool,
    snack: bool,
}

impl Daily {
    // 這天算「有學習」：到期複習 10 題、或清空當天到期、或練習 10 題（當天沒有到期時）、或用了連續保護
    fn qualified(&self) -> bool {
        self.due_reviews >= 10 || self.all_due_done || self.practice >= 10 || self.freeze_used
    }
}

fn daily(conn: &Connection, day: i64) -> rusqlite::Result<Daily> {
    Ok(conn
        .query_row(
            "SELECT due_reviews, practice, practice_xp, collect_coins, all_due_done, freeze_used, snack
             FROM game_daily WHERE day = ?1",
            [day],
            |r| {
                Ok(Daily {
                    due_reviews: r.get(0)?,
                    practice: r.get(1)?,
                    practice_xp: r.get(2)?,
                    collect_coins: r.get(3)?,
                    all_due_done: r.get::<_, i64>(4)? != 0,
                    freeze_used: r.get::<_, i64>(5)? != 0,
                    snack: r.get::<_, i64>(6)? != 0,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

// 欄位名稱只會是下面寫死的字串（不是使用者輸入）
fn bump(conn: &Connection, day: i64, col: &str, n: i64) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO game_daily(day) VALUES (?1)", [day])?;
    conn.execute(&format!("UPDATE game_daily SET {col} = {col} + ?2 WHERE day = ?1"), params![day, n])?;
    Ok(())
}

fn set_flag(conn: &Connection, day: i64, col: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO game_daily(day) VALUES (?1)", [day])?;
    conn.execute(&format!("UPDATE game_daily SET {col} = 1 WHERE day = ?1"), [day])?;
    Ok(())
}

/// 連續天數：今天還沒達標不算中斷，從昨天開始數
fn streak(conn: &Connection, today: i64) -> rusqlite::Result<i64> {
    let mut d = if daily(conn, today)?.qualified() { today } else { today - DAY };
    let mut n = 0;
    while n < 3650 && daily(conn, d)?.qualified() {
        n += 1;
        d -= DAY;
    }
    Ok(n)
}

fn streak_ending(conn: &Connection, last: i64) -> rusqlite::Result<i64> {
    let (mut d, mut n) = (last, 0);
    while n < 3650 && daily(conn, d)?.qualified() {
        n += 1;
        d -= DAY;
    }
    Ok(n)
}

/// 結算到昨天：沒達標的日子自動用掉連續保護；每週送一個免費保護（最多持有 2 個）
fn settle(conn: &Connection, today: i64) -> rusqlite::Result<()> {
    let mut o = load_opts(conn);
    if !o.enabled {
        return Ok(());
    }
    let yesterday = today - DAY;
    let mut d = if o.settled_through <= 0 { yesterday } else { (o.settled_through + DAY).max(yesterday - 400 * DAY) };
    while d <= yesterday {
        if !daily(conn, d)?.qualified() && streak_ending(conn, d - DAY)? > 0 && qty(conn, "freeze")? > 0 {
            add_item(conn, "freeze", -1)?;
            set_flag(conn, d, "freeze_used")?;
        }
        d += DAY;
    }
    o.settled_through = yesterday;
    let week = week_of(today);
    if week != o.last_free_week {
        if qty(conn, "freeze")? < MAX_FREEZES {
            add_item(conn, "freeze", 1)?;
        }
        o.last_free_week = week;
    }
    save_opts(conn, &o)
}

// ---- 成長 ----

/// 少年 → 成年的分支：看「少年期」怎麼學的
fn decide_branch(conn: &Connection, pet: &PetView, now: i64) -> rusqlite::Result<String> {
    let teen_at: i64 = conn
        .query_row("SELECT COALESCE(teen_at, hatched_at) FROM pets WHERE id = ?1", [pet.id], |r| r.get(0))?;
    let (total, listen, rare): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(r.quiz IN ('spell', 'recall')), 0),
                COALESCE(SUM(COALESCE(s.rank, 0) > 8000), 0)
         FROM pet_xp_log x
         JOIN review_log r ON r.id = x.review_id
         JOIN items i ON i.id = r.item_id
         LEFT JOIN seen_words s ON s.lemma = i.text
         WHERE x.pet_id = ?1 AND x.kind = 'due_ok' AND x.at >= ?2",
        params![pet.id, teen_at],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let days = ((now - teen_at) / DAY).max(1);
    let qualified: i64 = conn.query_row(
        "SELECT COUNT(*) FROM game_daily
         WHERE day >= ?1 AND (due_reviews >= 10 OR all_due_done = 1 OR practice >= 10 OR freeze_used = 1)",
        [teen_at - DAY],
        |r| r.get(0),
    )?;
    Ok(pick_branch(total, listen, rare, qualified, days))
}

pub fn pick_branch(total: i64, listen: i64, rare: i64, qualified_days: i64, days: i64) -> String {
    let ratio = |a: i64, b: i64| if b > 0 { a as f64 / b as f64 } else { 0.0 };
    let mut best = ("balance", 1.0);
    let candidates = [
        ("listen", if total >= 20 { ratio(listen, total) / 0.5 } else { 0.0 }),
        ("scholar", if total >= 20 { ratio(rare, total) / 0.3 } else { 0.0 }),
        ("grit", if days >= 5 { ratio(qualified_days.min(days), days) / 0.85 } else { 0.0 }),
    ];
    for (name, score) in candidates {
        if score >= best.1 {
            best = (name, score);
        }
    }
    best.0.to_string()
}

fn give_pet_xp(
    conn: &Connection,
    amount: i64,
    kind: &str,
    review_id: Option<i64>,
    now: i64,
    reward: &mut Reward,
) -> rusqlite::Result<()> {
    let Some(mut pet) = active_pet(conn)? else { return Ok(()) };
    if amount <= 0 || pet.level >= MAX_LEVEL {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO pet_xp_log(pet_id, at, amount, kind, review_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![pet.id, now, amount, kind, review_id],
    )?;
    reward.xp += amount;
    pet.xp += amount;
    while pet.level < MAX_LEVEL && pet.xp >= xp_need(pet.level) {
        pet.xp -= xp_need(pet.level);
        pet.level += 1;
        reward.level_up = Some(pet.level);
        add_coins(conn, 5, "levelup", Some(&pet.id.to_string()), now)?;
        reward.coins += 5;
        if pet.level == 10 {
            conn.execute("UPDATE pets SET teen_at = ?2 WHERE id = ?1", params![pet.id, now])?;
            reward.evolved = Some("teen".into());
        }
        if pet.level == 20 {
            let branch = decide_branch(conn, &pet, now)?;
            conn.execute("UPDATE pets SET branch = ?2 WHERE id = ?1", params![pet.id, branch])?;
            reward.evolved = Some(branch);
        }
    }
    if pet.level >= MAX_LEVEL {
        pet.xp = 0;
    }
    conn.execute("UPDATE pets SET level = ?2, xp = ?3 WHERE id = ?1", params![pet.id, pet.level, pet.xp])?;
    Ok(())
}

fn hatch(conn: &Connection, egg: &EggView, now: i64) -> rusqlite::Result<PetView> {
    conn.execute("DELETE FROM eggs WHERE id = ?1", [egg.id])?;
    let shiny = rand_u64() % 64 == 0;
    // 沒有陪伴中的、或陪伴中的已滿級 → 新寵物直接陪伴
    let make_active = match active_pet(conn)? {
        None => true,
        Some(p) => p.level >= MAX_LEVEL,
    };
    if make_active {
        conn.execute("UPDATE pets SET active = 0", [])?;
    }
    conn.execute(
        "INSERT INTO pets(species, name, level, xp, shiny, active, accessories, hatched_at) VALUES (?1, ?2, 1, 0, ?3, ?4, '[]', ?5)",
        params![egg.species, default_name(&egg.species), shiny as i64, make_active as i64, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {PET_COLS} FROM pets WHERE id = ?1"), [id], row_pet)
}

fn warm_egg(conn: &Connection, now: i64, reward: &mut Reward) -> rusqlite::Result<()> {
    let Some(mut egg) = incubating_egg(conn)? else { return Ok(()) };
    egg.warmth += 1;
    if egg.warmth >= HATCH_WARMTH {
        let pet = hatch(conn, &egg, now)?;
        reward.notes.push(format!("蛋孵化了：{}{}！", pet.name, if pet.shiny { "（閃亮版）" } else { "" }));
        reward.hatched = Some(pet);
        reward.egg = incubating_egg(conn)?;
    } else {
        conn.execute("UPDATE eggs SET warmth = ?2 WHERE id = ?1", params![egg.id, egg.warmth])?;
        reward.egg = Some(egg);
    }
    Ok(())
}

fn practice_reward(conn: &Connection, ok: bool, day: i64, now: i64, reward: &mut Reward) -> rusqlite::Result<()> {
    bump(conn, day, "practice", 1)?;
    if ok && daily(conn, day)?.practice_xp < PRACTICE_XP_CAP {
        bump(conn, day, "practice_xp", 1)?;
        give_pet_xp(conn, 1, "practice", None, now, reward)?;
    }
    Ok(())
}

const MILESTONES: [(i64, i64); 3] = [(7, 50), (30, 200), (100, 500)];

fn streak_milestones(conn: &Connection, day: i64, now: i64, reward: &mut Reward) -> rusqlite::Result<()> {
    let s = streak(conn, day)?;
    let start = (day - (s - 1) * DAY).to_string(); // 這一段連續的起點，同一段只發一次
    for (n, amount) in MILESTONES {
        let kind = format!("streak{n}");
        if s < n {
            continue;
        }
        let done: bool = conn
            .query_row("SELECT 1 FROM coin_log WHERE kind = ?1 AND ref = ?2", params![kind, start], |_| Ok(()))
            .optional()?
            .is_some();
        if !done {
            add_coins(conn, amount, &kind, Some(&start), now)?;
            add_egg(conn, random_species(), &kind, now)?;
            reward.coins += amount;
            reward.notes.push(format!("連續 {n} 天！+{amount} 金幣，還拿到一顆蛋"));
        }
    }
    Ok(())
}

/// 複習評分之後呼叫（items 已經更新成新的排程）。was_due = 評分前這個項目已到期。
pub fn on_review(
    conn: &Connection,
    review_id: i64,
    quality: i64,
    was_due: bool,
    day: i64,
    now: i64,
) -> rusqlite::Result<Option<Reward>> {
    if !enabled(conn) {
        return Ok(None);
    }
    settle(conn, day)?;
    let mut reward = Reward::default();
    let ok = quality >= 3;
    if was_due {
        bump(conn, day, "due_reviews", 1)?;
        let today = daily(conn, day)?;
        let xp = match (ok, today.snack) {
            (true, true) => 12,
            (true, false) => 10,
            (false, _) => 2,
        };
        give_pet_xp(conn, xp, if ok { "due_ok" } else { "due_miss" }, Some(review_id), now, &mut reward)?;
        if ok {
            add_coins(conn, 2, "review", Some(&review_id.to_string()), now)?;
            reward.coins += 2;
            warm_egg(conn, now, &mut reward)?;
        }
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE due_at <= ?1", [now], |r| r.get(0))?;
        if left == 0 && !today.all_due_done {
            set_flag(conn, day, "all_due_done")?;
            give_pet_xp(conn, 30, "all_due", None, now, &mut reward)?;
            add_coins(conn, 10, "all_due", Some(&day.to_string()), now)?;
            reward.coins += 10;
            reward.notes.push("今天到期的都複習完了！+30 經驗 +10 金幣".into());
        }
    } else {
        practice_reward(conn, ok, day, now, &mut reward)?;
    }
    streak_milestones(conn, day, now, &mut reward)?;
    reward.pet = active_pet(conn)?;
    Ok(Some(reward))
}

/// 收藏新字：+1 金幣（每天最多 20）
pub fn on_collect(conn: &Connection, day: i64, now: i64) -> rusqlite::Result<()> {
    if !enabled(conn) || daily(conn, day)?.collect_coins >= COLLECT_COIN_CAP {
        return Ok(());
    }
    bump(conn, day, "collect_coins", 1)?;
    add_coins(conn, 1, "collect", None, now)
}

// ---- 指令 ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub options: Options,
    pub coins: i64,
    pub streak: i64,
    pub freezes: i64,
    pub snacks: i64,
    pub snack_today: bool,
    pub all_due_done: bool,
    pub due_today: i64,
    pub mood: String, // happy / normal / miss
    pub pet: Option<PetView>,
    pub pets: Vec<PetView>,
    pub eggs: Vec<EggView>,
    pub owned: Vec<String>, // 擁有的配件與場景
    pub discovered: Vec<String>, // 圖鑑：species:form（form = egg / baby / teen / 分支），閃亮版另加 species:shiny
}

fn state(conn: &Connection, day: i64) -> rusqlite::Result<GameState> {
    if enabled(conn) {
        settle(conn, day)?;
    }
    let options = load_opts(conn);
    let pets = pets(conn)?;
    let eggs = eggs(conn)?;
    let today = daily(conn, day)?;
    let last_review: Option<i64> = conn.query_row("SELECT MAX(at) FROM review_log", [], |r| r.get(0))?;
    let mood = match last_review {
        Some(t) if t >= day => "happy",
        Some(t) if t >= day - 2 * DAY => "normal",
        Some(_) => "miss",
        None => "normal",
    };
    let mut owned = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT item FROM inventory WHERE qty > 0")?;
        for it in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let it = it?;
            if catalog(&it).is_some_and(|c| c.kind == "accessory" || c.kind == "scene") {
                owned.push(it);
            }
        }
    }
    let mut discovered = Vec::new();
    for e in &eggs {
        discovered.push(format!("{}:egg", e.species));
    }
    for p in &pets {
        discovered.push(format!("{}:egg", p.species));
        discovered.push(format!("{}:baby", p.species));
        if p.stage >= 2 {
            discovered.push(format!("{}:teen", p.species));
        }
        if let (3, Some(b)) = (p.stage, &p.branch) {
            discovered.push(format!("{}:{b}", p.species));
        }
        if p.shiny {
            discovered.push(format!("{}:shiny", p.species));
        }
    }
    discovered.sort();
    discovered.dedup();
    Ok(GameState {
        coins: coins(conn)?,
        streak: if options.enabled { streak(conn, day)? } else { 0 },
        freezes: qty(conn, "freeze")?,
        snacks: qty(conn, "snack")?,
        snack_today: today.snack,
        all_due_done: today.all_due_done,
        due_today: today.due_reviews,
        mood: mood.into(),
        pet: pets.iter().find(|p| p.active).cloned(),
        pets,
        eggs,
        owned,
        discovered,
        options,
    })
}

#[tauri::command]
pub fn game_state(db: State<'_, Db>, day_start: Option<i64>) -> Result<GameState, String> {
    let conn = db.0.lock().map_err(err)?;
    state(&conn, sane_day(day_start, now_ms())).map_err(err)
}

/// 打開遊戲模式。第一次：選一顆蛋＋起始禮包（依過去的複習次數換金幣，有上限）
#[tauri::command]
pub fn game_enable(db: State<'_, Db>, species: Option<String>, day_start: Option<i64>) -> Result<GameState, String> {
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    let day = sane_day(day_start, now);
    let mut o = load_opts(&conn);
    let fresh = pets(&conn).map_err(err)?.is_empty() && eggs(&conn).map_err(err)?.is_empty();
    let started: bool = conn
        .query_row("SELECT 1 FROM coin_log WHERE kind = 'starter'", [], |_| Ok(()))
        .optional()
        .map_err(err)?
        .is_some();
    if fresh && !started {
        let species = species.filter(|s| SPECIES.contains(&s.as_str())).ok_or("invalid-species")?;
        conn.execute(
            "INSERT INTO eggs(species, warmth, incubating, obtained_at, source) VALUES (?1, 0, 1, ?2, 'starter')",
            params![species, now],
        )
        .map_err(err)?;
        let reviews: i64 = conn.query_row("SELECT COUNT(*) FROM review_log", [], |r| r.get(0)).map_err(err)?;
        add_coins(&conn, 50 + reviews.min(250), "starter", None, now).map_err(err)?;
        add_item(&conn, "freeze", 1).map_err(err)?;
        o.last_free_week = week_of(day);
    }
    o.enabled = true;
    // 關掉期間的日子不結算（不會因為關掉遊戲而用掉保護）
    o.settled_through = day - DAY;
    save_opts(&conn, &o).map_err(err)?;
    state(&conn, day).map_err(err)
}

#[tauri::command]
pub fn game_disable(db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    let mut o = load_opts(&conn);
    o.enabled = false;
    save_opts(&conn, &o).map_err(err)
}

#[tauri::command]
pub fn game_options(
    db: State<'_, Db>,
    companion: Option<bool>,
    sound: Option<bool>,
    scene: Option<String>,
) -> Result<Options, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut o = load_opts(&conn);
    if let Some(v) = companion {
        o.companion = v;
    }
    if let Some(v) = sound {
        o.sound = v;
    }
    if let Some(s) = scene {
        if s != "room" && qty(&conn, &s).map_err(err)? <= 0 {
            return Err("not-owned".into());
        }
        o.scene = s;
    }
    save_opts(&conn, &o).map_err(err)?;
    Ok(o)
}

#[tauri::command]
pub fn pet_set_active(db: State<'_, Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE pets SET active = (id = ?1)", [id]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn pet_rename(db: State<'_, Db>, id: i64, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 12 {
        return Err("invalid-name".into());
    }
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE pets SET name = ?2 WHERE id = ?1", params![id, name]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn egg_incubate(db: State<'_, Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE eggs SET incubating = (id = ?1)", [id]).map_err(err)?;
    Ok(())
}

/// 配件：同一個位置（頭、臉、脖子）只能戴一個
#[tauri::command]
pub fn pet_equip(db: State<'_, Db>, pet_id: i64, item: String, on: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    let cat = catalog(&item).filter(|c| c.kind == "accessory").ok_or("invalid-item")?;
    if on && qty(&conn, &item).map_err(err)? <= 0 {
        return Err("not-owned".into());
    }
    let raw: String = conn
        .query_row("SELECT accessories FROM pets WHERE id = ?1", [pet_id], |r| r.get(0))
        .map_err(err)?;
    let mut list: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    list.retain(|a| a != &item && (!on || catalog(a).map(|c| c.slot) != Some(cat.slot)));
    if on {
        list.push(item);
    }
    conn.execute(
        "UPDATE pets SET accessories = ?2 WHERE id = ?1",
        params![pet_id, serde_json::to_string(&list).unwrap_or_default()],
    )
    .map_err(err)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopItem {
    pub id: String,
    pub kind: String,
    pub slot: String,
    pub price: i64,
    pub owned: i64,
    pub available: bool,
    pub species: Option<String>, // 每週的蛋
}

fn weekly_egg_species(day: i64) -> &'static str {
    SPECIES[week_of(day).rem_euclid(SPECIES.len() as i64) as usize]
}

fn egg_bought_this_week(conn: &Connection, day: i64) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM coin_log WHERE kind = 'buy:egg' AND ref = ?1",
            [week_of(day).to_string()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[tauri::command]
pub fn shop_list(db: State<'_, Db>, day_start: Option<i64>) -> Result<Vec<ShopItem>, String> {
    let conn = db.0.lock().map_err(err)?;
    let day = sane_day(day_start, now_ms());
    let mut out = Vec::new();
    for c in CATALOG {
        let owned = qty(&conn, c.id).map_err(err)?;
        let available = match c.kind {
            "accessory" | "scene" => owned == 0,
            "freeze" => owned < MAX_FREEZES,
            "egg" => !egg_bought_this_week(&conn, day).map_err(err)?,
            _ => true,
        };
        out.push(ShopItem {
            id: c.id.into(),
            kind: c.kind.into(),
            slot: c.slot.into(),
            price: c.price,
            owned,
            available,
            species: (c.kind == "egg").then(|| weekly_egg_species(day).to_string()),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn shop_buy(db: State<'_, Db>, id: String, day_start: Option<i64>) -> Result<GameState, String> {
    let conn = db.0.lock().map_err(err)?;
    let now = now_ms();
    let day = sane_day(day_start, now);
    if !enabled(&conn) {
        return Err("game-off".into());
    }
    let c = catalog(&id).ok_or("invalid-item")?;
    if coins(&conn).map_err(err)? < c.price {
        return Err("not-enough-coins".into());
    }
    let owned = qty(&conn, c.id).map_err(err)?;
    let mut refv = None;
    match c.kind {
        "accessory" | "scene" if owned > 0 => return Err("already-owned".into()),
        "freeze" if owned >= MAX_FREEZES => return Err("sold-out".into()),
        "egg" => {
            if egg_bought_this_week(&conn, day).map_err(err)? {
                return Err("sold-out".into());
            }
            refv = Some(week_of(day).to_string());
            add_egg(&conn, weekly_egg_species(day), "shop", now).map_err(err)?;
        }
        _ => {}
    }
    if c.kind != "egg" {
        add_item(&conn, c.id, 1).map_err(err)?;
    }
    add_coins(&conn, -c.price, &format!("buy:{}", c.id), refv.as_deref(), now).map_err(err)?;
    state(&conn, day).map_err(err)
}

/// 點心：當天到期複習答對的經驗 ×1.2
#[tauri::command]
pub fn snack_use(db: State<'_, Db>, day_start: Option<i64>) -> Result<GameState, String> {
    let conn = db.0.lock().map_err(err)?;
    let day = sane_day(day_start, now_ms());
    if daily(&conn, day).map_err(err)?.snack {
        return Err("snack-used".into());
    }
    if qty(&conn, "snack").map_err(err)? <= 0 {
        return Err("not-owned".into());
    }
    add_item(&conn, "snack", -1).map_err(err)?;
    set_flag(&conn, day, "snack").map_err(err)?;
    state(&conn, day).map_err(err)
}

/// 練習模式（不影響排程）的作答
#[tauri::command]
pub fn game_practice(db: State<'_, Db>, correct: bool, day_start: Option<i64>) -> Result<Option<Reward>, String> {
    let conn = db.0.lock().map_err(err)?;
    if !enabled(&conn) {
        return Ok(None);
    }
    let now = now_ms();
    let day = sane_day(day_start, now);
    settle(&conn, day).map_err(err)?;
    let mut reward = Reward::default();
    practice_reward(&conn, correct, day, now, &mut reward).map_err(err)?;
    streak_milestones(&conn, day, now, &mut reward).map_err(err)?;
    reward.pet = active_pet(&conn).map_err(err)?;
    Ok(Some(reward))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinEntry {
    pub at: i64,
    pub amount: i64,
    pub kind: String,
}

#[tauri::command]
pub fn coin_history(db: State<'_, Db>, limit: i64) -> Result<Vec<CoinEntry>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT at, amount, kind FROM coin_log ORDER BY id DESC LIMIT ?1")
        .map_err(err)?;
    let rows = stmt
        .query_map([limit.clamp(1, 500)], |r| Ok(CoinEntry { at: r.get(0)?, amount: r.get(1)?, kind: r.get(2)? }))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn enable(conn: &Connection, day: i64) {
        let o = Options { enabled: true, settled_through: day - DAY, ..Default::default() };
        save_opts(conn, &o).unwrap();
    }

    fn add_review(conn: &Connection, quiz: &str, at: i64) -> i64 {
        conn.execute(
            "INSERT OR IGNORE INTO items(kind, text, created_at, due_at) VALUES ('word', 'w', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_log(item_id, at, quality, quiz) VALUES (1, ?1, 4, ?2)",
            params![at, quiz],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn curve_pacing() {
        // 每天約 200 經驗：Lv.10 約 8 天、Lv.30 約 100 天
        let total = |to: i64| (1..to).map(xp_need).sum::<i64>() as f64 / 198.0;
        assert!((7.0..10.0).contains(&total(10)));
        assert!((85.0..115.0).contains(&total(30)));
    }

    #[test]
    fn off_writes_nothing() {
        let conn = db();
        let now = 100 * DAY;
        assert!(on_review(&conn, 1, 4, true, now, now).unwrap().is_none());
        on_collect(&conn, now, now).unwrap();
        let n: i64 = conn
            .query_row("SELECT (SELECT COUNT(*) FROM coin_log) + (SELECT COUNT(*) FROM game_daily)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn egg_hatches_after_30_due_correct() {
        let conn = db();
        let day = 100 * DAY;
        enable(&conn, day);
        conn.execute("INSERT INTO eggs(species, warmth, incubating, obtained_at, source) VALUES ('nori', 0, 1, 0, 'starter')", [])
            .unwrap();
        // 讓「全部到期都完成」不觸發：留一個到期的項目
        conn.execute("INSERT INTO items(kind, text, created_at, due_at) VALUES ('word', 'left', 0, 0)", []).unwrap();
        let mut hatched = None;
        for i in 0..HATCH_WARMTH {
            let r = on_review(&conn, i + 1, 4, true, day, day + i).unwrap().unwrap();
            if r.hatched.is_some() {
                hatched = r.hatched;
                assert_eq!(i, HATCH_WARMTH - 1);
            }
        }
        let pet = hatched.expect("應該孵化");
        assert_eq!((pet.species.as_str(), pet.level, pet.active), ("nori", 1, true));
        // 練習不會暖蛋，經驗有上限
        for _ in 0..100 {
            on_review(&conn, 999, 4, false, day, day).unwrap();
        }
        assert_eq!(daily(&conn, day).unwrap().practice_xp, PRACTICE_XP_CAP);
    }

    #[test]
    fn level_up_and_teen() {
        let conn = db();
        let day = 100 * DAY;
        enable(&conn, day);
        conn.execute("INSERT INTO pets(species, name, hatched_at, active) VALUES ('pip', 'p', 0, 1)", []).unwrap();
        let mut r = Reward::default();
        let need: i64 = (1..10).map(xp_need).sum();
        give_pet_xp(&conn, need, "due_ok", None, day, &mut r).unwrap();
        assert_eq!(r.level_up, Some(10));
        assert_eq!(r.evolved.as_deref(), Some("teen"));
        assert_eq!(active_pet(&conn).unwrap().unwrap().stage, 2);
    }

    #[test]
    fn branch_choice() {
        assert_eq!(pick_branch(100, 70, 10, 10, 30), "listen");
        assert_eq!(pick_branch(100, 20, 50, 10, 30), "scholar");
        assert_eq!(pick_branch(100, 20, 10, 30, 30), "grit");
        assert_eq!(pick_branch(100, 30, 15, 20, 30), "balance");
        assert_eq!(pick_branch(5, 5, 5, 1, 1), "balance");
    }

    #[test]
    fn branch_from_listening_reviews() {
        let conn = db();
        enable(&conn, 100 * DAY);
        conn.execute("INSERT INTO pets(species, name, hatched_at, teen_at, active) VALUES ('pip', 'p', 0, 0, 1)", [])
            .unwrap();
        for i in 0..30 {
            let rid = add_review(&conn, if i < 20 { "spell" } else { "choice" }, i);
            conn.execute(
                "INSERT INTO pet_xp_log(pet_id, at, amount, kind, review_id) VALUES (1, ?1, 10, 'due_ok', ?2)",
                params![i, rid],
            )
            .unwrap();
        }
        let pet = active_pet(&conn).unwrap().unwrap();
        assert_eq!(decide_branch(&conn, &pet, 2 * DAY).unwrap(), "listen");
    }

    #[test]
    fn streak_with_freeze() {
        let conn = db();
        let d0 = 100 * DAY;
        enable(&conn, d0);
        for i in 0..3 {
            set_flag(&conn, d0 + i * DAY, "all_due_done").unwrap();
        }
        add_item(&conn, "freeze", 1).unwrap();
        // 第 4 天沒來，第 5 天回來 → 自動用掉保護，連續不中斷
        let mut o = load_opts(&conn);
        o.settled_through = d0 + 2 * DAY;
        o.last_free_week = week_of(d0 + 4 * DAY);
        save_opts(&conn, &o).unwrap();
        settle(&conn, d0 + 4 * DAY).unwrap();
        assert!(daily(&conn, d0 + 3 * DAY).unwrap().freeze_used);
        set_flag(&conn, d0 + 4 * DAY, "all_due_done").unwrap();
        assert_eq!(streak(&conn, d0 + 4 * DAY).unwrap(), 5);
        // 再斷兩天、沒有保護 → 中斷
        settle(&conn, d0 + 7 * DAY).unwrap();
        assert_eq!(streak(&conn, d0 + 7 * DAY).unwrap(), 0);
    }

    #[test]
    fn streak_milestone_once() {
        let conn = db();
        let d0 = 100 * DAY;
        enable(&conn, d0);
        for i in 0..7 {
            set_flag(&conn, d0 + i * DAY, "all_due_done").unwrap();
        }
        let today = d0 + 6 * DAY;
        let mut r = Reward::default();
        streak_milestones(&conn, today, today, &mut r).unwrap();
        assert_eq!(r.coins, 50);
        let mut r2 = Reward::default();
        streak_milestones(&conn, today, today, &mut r2).unwrap();
        assert_eq!(r2.coins, 0);
        assert_eq!(eggs(&conn).unwrap().len(), 1);
    }

    #[test]
    fn shop_slots() {
        let conn = db();
        conn.execute("INSERT INTO pets(species, name, hatched_at, active) VALUES ('pip', 'p', 0, 1)", []).unwrap();
        for it in ["cap", "crown", "glasses"] {
            add_item(&conn, it, 1).unwrap();
        }
        // 直接測換配件邏輯（不經 State）
        let equip = |item: &str| {
            let cat = catalog(item).unwrap();
            let raw: String = conn.query_row("SELECT accessories FROM pets WHERE id = 1", [], |r| r.get(0)).unwrap();
            let mut list: Vec<String> = serde_json::from_str(&raw).unwrap();
            list.retain(|a| a != item && catalog(a).map(|c| c.slot) != Some(cat.slot));
            list.push(item.to_string());
            conn.execute("UPDATE pets SET accessories = ?1 WHERE id = 1", [serde_json::to_string(&list).unwrap()])
                .unwrap();
        };
        equip("cap");
        equip("glasses");
        equip("crown");
        assert_eq!(active_pet(&conn).unwrap().unwrap().accessories, vec!["glasses", "crown"]);
    }
}
