import { useState, useCallback } from 'react'

export interface DeviceInfo {
  chip: string
  flashSize: string
  port: SerialPort
}

export function useWebSerial() {
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSupported = 'serial' in navigator

  const connect = useCallback(async () => {
    if (!isSupported) {
      setError('当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge')
      return
    }
    try {
      setConnecting(true)
      setError(null)
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200 })

      // TODO: 集成 esptool-js 进行芯片检测
      // 现阶段先用占位符
      setDevice({
        chip: 'ESP32',        // 待 esptool-js 真实检测
        flashSize: '4MB',
        port,
      })
    } catch (e: unknown) {
      const err = e as Error
      setError(err.message || '连接失败')
    } finally {
      setConnecting(false)
    }
  }, [isSupported])

  const disconnect = useCallback(async () => {
    if (device?.port) {
      await device.port.close()
      setDevice(null)
    }
  }, [device])

  return { device, connecting, error, isSupported, connect, disconnect }
}
