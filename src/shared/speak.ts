// 發音：有字典音檔就播，失敗或沒有就用系統 TTS（WebView2 在 Windows 有自然語音）
export function speak(text: string, audioUrl?: string | null, rate = 0.9): void {
  if (audioUrl) {
    new Audio(audioUrl).play().catch(() => speakSentence(text, rate))
    return
  }
  speakSentence(text, rate)
}

function voice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices()
  return (
    voices.find((v) => v.lang === 'en-US' && /natural|online/i.test(v.name)) ??
    voices.find((v) => v.lang === 'en-US') ??
    voices.find((v) => v.lang.startsWith('en'))
  )
}

// 念一句英文；onWord(字元位置) 在念到每個字時呼叫（有些語音不提供，就不會呼叫），念完呼叫 onWord(-1)
export function speakSentence(text: string, rate = 0.9, onWord?: (charIndex: number) => void): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.rate = rate
    const v = voice()
    if (v) u.voice = v
    if (onWord) {
      u.onboundary = (e) => {
        if (e.name === 'word') onWord(e.charIndex)
      }
      u.onend = () => onWord(-1)
      u.onerror = () => onWord(-1)
    }
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    onWord?.(-1) // 環境不支援 TTS 就安靜略過
  }
}
