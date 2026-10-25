// 本機 AI CLI（AI 翻譯、AI 解釋、AI 例句用）。prefs.model 帶引擎前綴：
// 「haiku」= Claude、「codex:gpt-5.6-luna」、「agy:gemini-3.8-flash-low」、「gemini:」（冒號後空白 = CLI 預設模型）
export type Provider = 'claude' | 'codex' | 'agy' | 'gemini'

export interface ProviderInfo {
  id: Provider
  name: string
  cli: string // 終端機指令
  install: string // 官方安裝教學（Rust 端 open_ai_site 的白名單要同步）
  login: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    install: 'https://code.claude.com/docs/en/setup',
    login: '在終端機執行 claude 登入 Claude 帳號',
  },
  {
    id: 'codex',
    name: 'Codex（OpenAI）',
    cli: 'codex',
    install: 'https://developers.openai.com/codex/cli',
    login: '在終端機執行 codex，選 Sign in with ChatGPT',
  },
  {
    id: 'agy',
    name: 'Antigravity（Google，agy）',
    cli: 'agy',
    install: 'https://antigravity.google/docs/cli',
    login: '在終端機執行 agy 登入 Google 帳號',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI（Google）',
    cli: 'gemini',
    install: 'https://geminicli.com/docs/get-started/installation',
    login: '在終端機執行 gemini，選 Login with Google',
  },
]

export interface ModelOption {
  id: string
  label: string
}

// 固定清單；Codex、agy 的會再向 CLI 查（api.aiModels）
export const STATIC_MODELS: Record<Provider, ModelOption[]> = {
  claude: [
    { id: 'haiku', label: 'Haiku（快、省）' },
    { id: 'sonnet', label: 'Sonnet（品質較好）' },
    { id: 'opus', label: 'Opus（最好、較慢）' },
  ],
  codex: [{ id: '', label: 'CLI 預設模型' }],
  agy: [{ id: '', label: 'CLI 預設模型' }],
  gemini: [
    { id: '', label: 'CLI 預設模型' },
    { id: 'flash', label: 'Flash（快、省）' },
    { id: 'pro', label: 'Pro（品質較好）' },
  ],
}

const IDS = PROVIDERS.map((p) => p.id) as string[]

export function parseModel(model: string): { provider: Provider; model: string } {
  const i = model.indexOf(':')
  if (i > 0 && IDS.includes(model.slice(0, i))) return { provider: model.slice(0, i) as Provider, model: model.slice(i + 1) }
  return { provider: 'claude', model }
}

export function joinModel(provider: Provider, model: string): string {
  return provider === 'claude' ? model : `${provider}:${model}`
}

export const providerInfo = (p: Provider) => PROVIDERS.find((x) => x.id === p)!

/** 換引擎時的預設模型 */
export function defaultModel(p: Provider): string {
  return joinModel(p, STATIC_MODELS[p][0].id)
}

/** 給人看的名稱：「Codex・gpt-5.6-luna」「Claude・haiku」 */
export function modelLabel(full: string): string {
  const { provider, model } = parseModel(full)
  const name = providerInfo(provider).name.replace(/（.*$/, '')
  return model ? `${name}・${model}` : name
}

/** 下拉選單：固定清單＋CLI 查到的，目前的值一定在裡面 */
export function modelOptions(p: Provider, fetched: ModelOption[], current: string): ModelOption[] {
  const list = [...STATIC_MODELS[p]]
  for (const m of fetched) if (!list.some((x) => x.id === m.id)) list.push(m)
  const cur = parseModel(current)
  if (cur.provider === p && !list.some((x) => x.id === cur.model)) list.push({ id: cur.model, label: cur.model })
  return list
}
