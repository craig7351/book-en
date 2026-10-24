// 把一句英文切成 token：單字可點，標點留在原位（LingoTube 已修正過的邏輯）

export interface Token {
  pre: string // 單字前的標點
  word: string // 可點的單字（空字串 = 這段沒有單字）
  post: string // 單字後的標點與空白
}

// 單字本體可含 ' ’ -，前後標點分開
const TOKEN_RE = /^([^A-Za-z]*)([A-Za-z](?:[A-Za-z'’-]*[A-Za-z])?)([\s\S]*)$/

export function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue
    if (/^\s+$/.test(part)) {
      if (out.length) out[out.length - 1].post += part
      else out.push({ pre: part, word: '', post: '' })
      continue
    }
    const m = part.match(TOKEN_RE)
    if (m && m[2].length > 1) out.push({ pre: m[1], word: m[2], post: m[3] })
    else if (m && /^[aAI]$/.test(m[2])) out.push({ pre: m[1], word: m[2], post: m[3] }) // a / I 也可點
    else out.push({ pre: part, word: '', post: '' })
  }
  return out
}

export const normWord = (w: string) => w.replace(/’/g, "'").toLowerCase()

// 可能的原形（粗略還原屈折變化），用來判斷字幕中的字是否已收藏
export function lemmaCandidates(word: string): string[] {
  const w = normWord(word)
  const c = new Set([w])
  const strip = (suffix: string, add = '') => {
    if (w.endsWith(suffix) && w.length > suffix.length + 1) c.add(w.slice(0, -suffix.length) + add)
  }
  strip("'s")
  strip('s')
  strip('es')
  strip('ies', 'y')
  strip('ied', 'y')
  strip('ed')
  strip('d')
  strip('ing')
  strip('ing', 'e')
  strip('er')
  strip('est')
  strip('ly')
  // 重複子音：running → runn → run
  for (const x of [...c]) if (/([b-df-hj-np-tv-z])\1$/.test(x)) c.add(x.slice(0, -1))
  return [...c]
}

export function isSaved(word: string, saved: Set<string>): boolean {
  return lemmaCandidates(word).some((x) => saved.has(x))
}
