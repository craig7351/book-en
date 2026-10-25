import { useEffect, useState } from 'react'
import { api } from './api'
import { modelOptions, type ModelOption, type Provider } from './aicli'

// 向 CLI 查過的模型清單（agy models 要連網，一次 App 執行期間只查一次）
const fetched = new Map<Provider, Promise<ModelOption[]>>()

function fetchModels(p: Provider): Promise<ModelOption[]> {
  if (p !== 'codex' && p !== 'agy') return Promise.resolve([])
  let f = fetched.get(p)
  if (!f) {
    f = api
      .aiModels(p)
      .then((list) => list.map(([id, label]) => ({ id, label })))
      .catch(() => {
        fetched.delete(p) // 失敗（例如還沒安裝）下次再試
        return []
      })
    fetched.set(p, f)
  }
  return f
}

/** 這個引擎可選的模型（固定清單＋CLI 查到的） */
export function useModelOptions(p: Provider, current: string): ModelOption[] {
  const [list, setList] = useState<ModelOption[]>([])
  useEffect(() => {
    let alive = true
    setList([])
    void fetchModels(p).then((l) => alive && setList(l))
    return () => {
      alive = false
    }
  }, [p])
  return modelOptions(p, list, current)
}
