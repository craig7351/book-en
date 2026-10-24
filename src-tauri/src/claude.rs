// 呼叫本機 Claude Code CLI（claude -p），用使用者已登入的帳號，不需 API key。
use std::io::Write;
use std::process::{Command, Stdio};

// 模型名稱會經過 cmd.exe，只允許安全字元，避免指令注入
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 64
        && model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

fn base_command() -> Command {
    // claude 在 Windows 是 npm 的 claude.cmd 包裝，Command::new("claude") 找不到 → 經由 cmd /C
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/C", "claude"]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要跳出主控台視窗
        c
    }
    #[cfg(not(windows))]
    {
        Command::new("claude")
    }
}

// 送出提示詞（走 stdin，避免命令列長度與跳脫問題），回傳模型的文字回覆
pub fn run(prompt: &str, model: &str) -> Result<String, String> {
    if !valid_model(model) {
        return Err(format!("invalid-model: {model}"));
    }
    let mut child = base_command()
        .args(["-p", "--model", model, "--output-format", "json", "--tools", "", "--no-session-persistence"])
        .current_dir(std::env::temp_dir()) // 不要讀到任何專案的 CLAUDE.md
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("claude-not-found: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no-stdin")?
        .write_all(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() { "claude-failed".to_string() } else { format!("claude-failed: {msg}") }
    })?;
    let result = v["result"].as_str().unwrap_or_default().to_string();
    if v["is_error"].as_bool() == Some(true) {
        return Err(format!("claude-error: {result}"));
    }
    Ok(result)
}

pub fn version() -> Result<String, String> {
    let out = base_command().arg("--version").output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("claude-not-found".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// 模型回覆中取出 JSON 陣列（容忍前後多餘文字或 ``` 圍欄）
pub fn extract_json_array(text: &str) -> Option<serde_json::Value> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    serde_json::from_str(&text[start..=end]).ok()
}
