import { useEffect, useRef, useCallback } from 'react'

export type WSMessage = {
  type: 'log' | 'progress' | 'done'
  level?: 'info' | 'error' | 'warning'
  text?: string
  percent?: number
  stage?: string
  status?: 'success' | 'failed'
  bin_url?: string
  stats?: { bin_size: number; flash_pct: number; ram_pct: number }
  error?: string
}

export function useWebSocket(buildId: string | null, onMessage: (msg: WSMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null)

  const connect = useCallback(() => {
    if (!buildId) return
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/builds/${buildId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        onMessage(msg)
      } catch {
        const text = String(e.data)
        let level: 'info' | 'error' | 'warning' = 'info'
        const lower = text.toLowerCase()
        if (text.includes('[ERROR]') || lower.includes('error:') || lower.includes('fatal error')) {
          level = 'error'
        } else if (text.includes('[WARN') || lower.includes('warning:')) {
          level = 'warning'
        }
        onMessage({ type: 'log', level, text })
      }
    }
    ws.onclose = () => { wsRef.current = null }
  }, [buildId, onMessage])

  useEffect(() => {
    connect()
    return () => wsRef.current?.close()
  }, [connect])
}
