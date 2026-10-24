// 發音：有字典音檔就播，失敗或沒有就用系統 TTS（WebView2 在 Windows 有自然語音）
export function speak(text: string, audioUrl?: string | null, rate = 0.9): void {
  if (audioUrl) {
    new Audio(audioUrl).play().catch(() => tts(text, rate))
    return
  }
  tts(text, rate)
}

function tts(text: string, rate: number): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.rate = rate
    const voice = speechSynthesis.getVoices().find((v) => v.lang === 'en-US' && /natural|online/i.test(v.name))
    if (voice) u.voice = voice
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    /* 環境不支援就略過 */
  }
}
