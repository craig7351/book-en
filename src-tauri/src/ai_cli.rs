// 呼叫本機的 AI CLI（Claude Code / Codex / Antigravity agy / Gemini CLI），用使用者已登入的帳號，不需 API key。
// 模型字串帶引擎前綴：「haiku」= Claude、「codex:gpt-5.6-luna」、「agy:gemini-3.8-flash-low」、「gemini:」（冒號後空白 = CLI 預設模型）。
use std::io::Write;
use std::process::{Command, Output, Stdio};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cli {
    Claude,
    Codex,
    Agy,
    Gemini,
}

impl Cli {
    pub fn from_id(id: &str) -> Option<Cli> {
        match id {
            "claude" => Some(Cli::Claude),
            "codex" => Some(Cli::Codex),
            "agy" => Some(Cli::Agy),
            "gemini" => Some(Cli::Gemini),
            _ => None,
        }
    }
    fn exe(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Agy => "agy",
            Cli::Gemini => "gemini",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
            Cli::Agy => "Antigravity",
            Cli::Gemini => "Gemini CLI",
        }
    }
}

/// 「codex:gpt-5.6-luna」→ (Codex, "gpt-5.6-luna")；沒有已知前綴 = Claude
pub fn parse_model(model: &str) -> (Cli, &str) {
    if let Some((p, m)) = model.split_once(':') {
        if let Some(cli) = Cli::from_id(p) {
            return (cli, m);
        }
    }
    (Cli::Claude, model)
}

// 模型名稱會當成命令列參數（Windows 還會經過 cmd.exe），只允許安全字元，避免指令注入
fn valid_model(model: &str) -> bool {
    model.len() <= 64 && model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

fn base_command(cli: Cli) -> Command {
    // claude / codex / gemini 在 Windows 是 npm 的 .cmd 包裝，Command::new 找不到 → 經由 cmd /C（提示詞一律走 stdin，不經過 cmd）
    // agy 是真的 exe，而且提示詞只能當參數傳 → 直接執行，不能經過 cmd（字幕裡的 & | 會被當成指令）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = if cli == Cli::Agy {
            Command::new("agy")
        } else {
            let mut c = Command::new("cmd");
            c.args(["/C", cli.exe()]);
            c
        };
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要跳出主控台視窗
        c
    }
    #[cfg(not(windows))]
    {
        // macOS 從 Dock / Finder 開的 App 只有最基本的 PATH（/usr/bin:/bin…），
        // 找不到裝在 ~/.local/bin、Homebrew、npm global 的 CLI（npm 版還需要 node）→ 補上常見位置
        let mut c = Command::new(cli.exe());
        c.env("PATH", unix_path());
        c
    }
}

#[cfg(not(windows))]
fn unix_path() -> std::ffi::OsString {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = &home {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".volta/bin", ".bun/bin", "bin"] {
            dirs.push(home.join(d));
        }
        // nvm：每個 Node 版本各有 bin
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            dirs.extend(rd.flatten().map(|e| e.path().join("bin")));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(d.into());
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

// Windows 的 cmd /C 找不到指令時不會 spawn 失敗，而是回傳錯誤訊息
fn not_found(out: &Output) -> bool {
    let e = String::from_utf8_lossy(&out.stderr);
    e.contains("is not recognized") || e.contains("不是內部或外部命令") || e.contains("command not found")
}

fn spawn_err(cli: Cli, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("ai-not-found:{}", cli.name())
    } else {
        e.to_string()
    }
}

// 送出提示詞，回傳模型的文字回覆
pub fn run(prompt: &str, model: &str) -> Result<String, String> {
    let (cli, m) = parse_model(model);
    if !valid_model(m) || (cli == Cli::Claude && m.is_empty()) {
        return Err(format!("invalid-model: {model}"));
    }
    let mut cmd = base_command(cli);
    cmd.current_dir(std::env::temp_dir()); // 不要讀到任何專案的 CLAUDE.md / AGENTS.md / GEMINI.md
    match cli {
        Cli::Claude => {
            cmd.args(["-p", "--model", m, "--output-format", "json", "--tools", "", "--no-session-persistence"]);
        }
        Cli::Codex => {
            // 不讀使用者的 config.toml（裡面的預設模型、hooks、MCP 可能拖慢或出錯），唯讀沙盒、不留對話紀錄
            cmd.args(["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]);
            cmd.args(["--sandbox", "read-only", "--color", "never"]);
            if !m.is_empty() {
                cmd.args(["-m", m]);
            }
            cmd.arg("-");
        }
        Cli::Agy => {
            cmd.args(["--output-format", "json", "--disable-slash-commands", "--print-timeout", "600s"]);
            if !m.is_empty() {
                cmd.args(["--model", m]);
            }
            // agy 不從 stdin 讀提示詞；Windows 命令列上限 32K 字元
            if prompt.len() > 30_000 {
                return Err("ai-error:Antigravity:提示詞太長".into());
            }
            cmd.arg(format!("--print={prompt}"));
        }
        Cli::Gemini => {
            // -p 的內容會接在 stdin 後面
            cmd.args(["-o", "json", "-p", "Follow the instructions above."]);
            if !m.is_empty() {
                cmd.args(["-m", m]);
            }
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_err(cli, e))?;
    let mut stdin = child.stdin.take().ok_or("no-stdin")?;
    if cli != Cli::Agy {
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    drop(stdin);
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if not_found(&out) {
        return Err(format!("ai-not-found:{}", cli.name()));
    }
    parse_output(cli, &out.stdout, &out.stderr, out.status.success())
}

fn fail(cli: Cli, msg: &str) -> String {
    let msg = msg.trim();
    let msg = if msg.is_empty() { "沒有回覆" } else { msg };
    format!("ai-error:{}:{}", cli.name(), msg.chars().take(300).collect::<String>())
}

// 各家 CLI 的輸出格式
fn parse_output(cli: Cli, stdout: &[u8], stderr: &[u8], ok: bool) -> Result<String, String> {
    let text = String::from_utf8_lossy(stdout);
    let err_text = String::from_utf8_lossy(stderr);
    let json = |s: &str| -> Option<serde_json::Value> { serde_json::from_str(s.get(s.find('{')?..)?).ok() };
    match cli {
        Cli::Claude => {
            let v = json(&text).ok_or_else(|| fail(cli, &err_text))?;
            let result = v["result"].as_str().unwrap_or_default().to_string();
            if v["is_error"].as_bool() == Some(true) {
                return Err(fail(cli, &result));
            }
            Ok(result)
        }
        Cli::Codex => {
            // stdout 只有最後的回覆；錯誤在 stderr 的「ERROR: {json}」行
            if ok && !text.trim().is_empty() {
                return Ok(text.trim().to_string());
            }
            let line = err_text.lines().rev().find(|l| l.starts_with("ERROR:")).unwrap_or(err_text.trim());
            let msg = json(line)
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or_else(|| line.trim_start_matches("ERROR:").to_string());
            Err(fail(cli, &msg))
        }
        Cli::Agy => {
            let v = json(&text).ok_or_else(|| fail(cli, &err_text))?;
            if v["status"].as_str() == Some("SUCCESS") {
                return Ok(v["response"].as_str().unwrap_or_default().to_string());
            }
            Err(fail(cli, v["error"].as_str().unwrap_or(&err_text)))
        }
        Cli::Gemini => {
            if let Some(r) = json(&text).and_then(|v| v["response"].as_str().map(String::from)) {
                if ok {
                    return Ok(r);
                }
            }
            // 錯誤是 stderr 裡的 {"error": {"message", "code"}}
            let msg = json(&err_text)
                .or_else(|| json(&text))
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or_else(|| err_text.to_string());
            if msg.contains("Auth method") {
                return Err(fail(cli, "還沒登入：請在終端機執行 gemini 並選擇登入方式"));
            }
            Err(fail(cli, &msg))
        }
    }
}

/// 版本（順便確認裝了沒）
pub fn version(cli: Cli) -> Result<String, String> {
    let out = base_command(cli).arg("--version").output().map_err(|e| spawn_err(cli, e))?;
    if !out.status.success() || not_found(&out) {
        return Err(format!("ai-not-found:{}", cli.name()));
    }
    let v = String::from_utf8_lossy(&out.stdout);
    Ok(v.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().trim().to_string())
}

/// 可選的模型（id, 顯示名稱）；Claude、Gemini 用前端的固定清單
pub fn models(cli: Cli) -> Result<Vec<(String, String)>, String> {
    match cli {
        Cli::Codex => {
            // Codex 自己快取的模型清單（~/.codex/models_cache.json）
            let home = std::env::var_os("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| dirs_home().map(|h| h.join(".codex")))
                .ok_or("no-home")?;
            let text = std::fs::read_to_string(home.join("models_cache.json")).map_err(|e| e.to_string())?;
            Ok(codex_models(&text))
        }
        Cli::Agy => {
            let out = base_command(cli).arg("models").output().map_err(|e| spawn_err(cli, e))?;
            if !out.status.success() {
                return Err(fail(cli, &String::from_utf8_lossy(&out.stderr)));
            }
            Ok(agy_models(&String::from_utf8_lossy(&out.stdout)))
        }
        _ => Ok(vec![]),
    }
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(Into::into)
}

fn codex_models(text: &str) -> Vec<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str() == Some("list"))
        .filter_map(|m| {
            let id = m["slug"].as_str()?;
            valid_model(id).then(|| (id.to_string(), m["display_name"].as_str().unwrap_or(id).to_string()))
        })
        .collect()
}

// 「gemini-3.8-flash-low\tGemini 3.8 Flash (Low)」一行一個
fn agy_models(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let (id, name) = l.split_once('\t')?;
            let id = id.trim();
            (!id.is_empty() && valid_model(id)).then(|| (id.to_string(), name.trim().to_string()))
        })
        .collect()
}

// 模型回覆中取出 JSON 陣列（容忍前後多餘文字或 ``` 圍欄）
pub fn extract_json_array(text: &str) -> Option<serde_json::Value> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    serde_json::from_str(&text[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_models() {
        assert_eq!(parse_model("haiku"), (Cli::Claude, "haiku"));
        assert_eq!(parse_model("codex:gpt-5.6-luna"), (Cli::Codex, "gpt-5.6-luna"));
        assert_eq!(parse_model("gemini:"), (Cli::Gemini, ""));
        assert_eq!(parse_model("agy:gemini-3.8-flash-low"), (Cli::Agy, "gemini-3.8-flash-low"));
        assert!(!valid_model("a&b"));
        assert!(!valid_model("x y"));
        assert!(run("hi", "codex:a&calc").unwrap_err().starts_with("invalid-model"));
        assert!(run("hi", "").unwrap_err().starts_with("invalid-model"));
    }

    #[test]
    fn outputs() {
        let ok = |cli, out: &str, err: &str, success| parse_output(cli, out.as_bytes(), err.as_bytes(), success);
        assert_eq!(ok(Cli::Claude, r#"{"result":"[1]","is_error":false}"#, "", true).unwrap(), "[1]");
        assert_eq!(ok(Cli::Codex, "[{\"i\":1}]\n", "OpenAI Codex v0.146.0\n", true).unwrap(), "[{\"i\":1}]");
        let e = ok(
            Cli::Codex,
            "",
            "user\nhi\nERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"model not supported\"}}\n",
            false,
        )
        .unwrap_err();
        assert_eq!(e, "ai-error:Codex:model not supported");
        let agy = r#"{"conversation_id":"x","status":"SUCCESS","response":"[{\"i\":1,\"zh\":\"哈囉\"}]\n","num_turns":1}"#;
        assert_eq!(ok(Cli::Agy, agy, "", true).unwrap().trim(), "[{\"i\":1,\"zh\":\"哈囉\"}]");
        let agy_err = r#"{"status":"ERROR","response":"","error":"Error: empty prompt"}"#;
        assert_eq!(ok(Cli::Agy, agy_err, "", false).unwrap_err(), "ai-error:Antigravity:Error: empty prompt");
        assert_eq!(ok(Cli::Gemini, r#"{"response":"好","stats":{}}"#, "", true).unwrap(), "好");
        let gem_err = "Approval mode overridden.\n{\n \"session_id\": \"x\",\n \"error\": {\"type\": \"Error\", \"message\": \"Please set an Auth method in your settings.json\", \"code\": 41}\n}";
        assert!(ok(Cli::Gemini, "", gem_err, false).unwrap_err().contains("還沒登入"));
    }

    #[test]
    fn model_lists() {
        let codex = r#"{"models":[{"slug":"gpt-reserve","display_name":"R","visibility":"hide"},{"slug":"gpt-5.6-luna","display_name":"GPT-5.6 Luna","visibility":"list"}]}"#;
        assert_eq!(codex_models(codex), vec![("gpt-5.6-luna".to_string(), "GPT-5.6 Luna".to_string())]);
        let agy = "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nbad id\tX\n";
        assert_eq!(agy_models(agy), vec![("gemini-3.8-flash-low".to_string(), "Gemini 3.8 Flash (Low)".to_string())]);
    }

    // 實際呼叫本機 CLI（會用到帳號額度）：BOOKEN_AI_TEST=codex:gpt-5.6-luna cargo test real_cli -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_cli() {
        let model = std::env::var("BOOKEN_AI_TEST").unwrap_or_else(|_| "haiku".into());
        let (cli, _) = parse_model(&model);
        println!("version: {:?}", version(cli));
        let prompt = "Translate into Traditional Chinese (Taiwan). Reply with ONLY a JSON array [{\"i\":1,\"zh\":\"...\"}]\n1. Tom & Jerry say \"hi\" | bye\n2. 100% sure\n";
        let reply = run(prompt, &model);
        println!("reply: {reply:?}");
        let v = extract_json_array(&reply.unwrap()).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
    }

    #[test]
    fn extract_json() {
        let v = extract_json_array("```json\n[{\"i\":1,\"zh\":\"你好\"}]\n```").unwrap();
        assert_eq!(v[0]["zh"], "你好");
    }
}
