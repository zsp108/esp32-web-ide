import { useState, useCallback } from 'react'
import { ESPLoader, Transport, classicReset, usbJTAGSerialReset } from 'esptool-js'
import axios from 'axios'

export interface DeviceInfo {
  chip: string
  flashSize: string
  port: SerialPort
  transport: Transport
  esploader: ESPLoader
}

export function useWebSerial() {
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [flashProgress, setFlashProgress] = useState(0)
  const [flashStage, setFlashStage] = useState('')
  const [flashSuccess, setFlashSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator

  const connect = useCallback(async (onLog?: (msg: string) => void) => {
    if (!isSupported) {
      setError('当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器')
      return
    }
    try {
      setConnecting(true)
      setError(null)
      onLog?.('等待用户选择串口设备...')
      const port = await navigator.serial.requestPort()

      const transport = new Transport(port)
      const terminal = {
        clean: () => {},
        writeLine: (data: string) => {
          const t = data.trim()
          if (t) onLog?.(t)
        },
        write: (data: string) => {
          const t = data.trim()
          if (t) onLog?.(t)
        },
      }

      onLog?.('正在连接 ESP32 并检测芯片型号...')
      const esploader = new ESPLoader({
        transport,
        baudrate: 921600,
        romBaudrate: 115200,
        terminal,
      })

      const chip = await esploader.main()
      let flashSizeStr = '未知'
      try {
        const flashBytes = await esploader.getFlashSize()
        if (flashBytes) {
          flashSizeStr = `${Math.round(flashBytes / (1024 * 1024))}MB`
        }
      } catch {}

      onLog?.(`连接成功: ${chip} (Flash 大小: ${flashSizeStr})`)
      setDevice({
        chip,
        flashSize: flashSizeStr,
        port,
        transport,
        esploader,
      })
    } catch (e: unknown) {
      const err = e as Error
      const msg = err.message || '连接设备失败'
      setError(msg)
      onLog?.(`[ERROR] 连接设备失败: ${msg}`)
    } finally {
      setConnecting(false)
    }
  }, [isSupported])

  const disconnect = useCallback(async () => {
    if (device?.transport) {
      try {
        if (device.esploader) {
          await device.esploader.hardReset()
        }
        await device.transport.disconnect()
      } catch {}
    } else if (device?.port) {
      try {
        await device.port.close()
      } catch {}
    }
    setDevice(null)
  }, [device])

  const flashFirmware = useCallback(async (
    binUrl: string,
    onProgress?: (pct: number) => void,
    onLog?: (msg: string) => void,
  ) => {
    if (!isSupported) {
      throw new Error('当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器')
    }

    setFlashing(true)
    setFlashProgress(0)
    setFlashStage('正在下载固件...')
    setFlashSuccess(false)
    setError(null)

    let activeTransport: Transport | null = null
    let activeLoader: ESPLoader | null = null

    try {
      onLog?.('正在从服务器获取已编译的固件 (.bin)...')
      const resp = await axios.get(binUrl, { responseType: 'blob' })
      const blob = resp.data as Blob
      const kbSize = (blob.size / 1024).toFixed(1)
      onLog?.(`固件下载完成 (${kbSize} KB)，正在解析二进制数据...`)
      setFlashStage(`固件下载完成 (${kbSize} KB)，准备串口...`)

      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('读取固件二进制数据失败'))
        if (reader.readAsBinaryString) {
          reader.readAsBinaryString(blob)
        } else {
          const bufReader = new FileReader()
          bufReader.onload = () => {
            const bytes = new Uint8Array(bufReader.result as ArrayBuffer)
            let binary = ''
            const len = bytes.byteLength
            const chunk = 8192
            for (let i = 0; i < len; i += chunk) {
              binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunk, len))))
            }
            resolve(binary)
          }
          bufReader.onerror = () => reject(new Error('读取固件二进制数据失败'))
          bufReader.readAsArrayBuffer(blob)
        }
      })

      const terminal = {
        clean: () => {},
        writeLine: (data: string) => {
          const t = data.trim()
          if (t) onLog?.(t)
        },
        write: (data: string) => {
          const t = data.trim()
          if (t) onLog?.(t)
        },
      }

      if (device?.transport && device?.esploader) {
        activeTransport = device.transport
        activeLoader = device.esploader
        ;(activeLoader as any).terminal = terminal
        onLog?.(`使用当前已连接的设备: ${device.chip}`)
        setFlashStage(`正在连接芯片 ${device.chip}...`)
      } else {
        onLog?.('请在弹出的系统串口选择窗口中，选择您的 ESP32 设备端口...')
        setFlashStage('等待选择串口端口...')
        const port = await navigator.serial.requestPort()
        activeTransport = new Transport(port)
        activeLoader = new ESPLoader({
          transport: activeTransport,
          baudrate: 921600,
          romBaudrate: 115200,
          terminal,
        })
        onLog?.('正在向 ESP32 发送同步握手信号...')
        setFlashStage('正在同步握手并进入 Bootloader 模式...')
        const chip = await activeLoader.main()
        onLog?.(`已成功握手，识别芯片型号: ${chip}`)
      }

      onLog?.('开始擦除并写入固件至 ESP32 Flash (偏移地址 0x0)...')
      setFlashStage('正在擦除并烧录固件...')

      await activeLoader.writeFlash({
        fileArray: [{ data: fileData, address: 0x0 }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex: number, written: number, total: number) => {
          const pct = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0
          setFlashProgress(pct)
          setFlashStage(`正在烧录固件... ${pct}%`)
          onProgress?.(pct)
        },
      })

      setFlashProgress(100)
      setFlashStage('固件烧录完成，正在重启设备...')
      onLog?.('固件数据写入 100% 完成！正在执行硬件复位重启 ESP32...')

      try {
        if (activeTransport) {
          await usbJTAGSerialReset(activeTransport)
        }
      } catch {}
      try {
        await activeLoader.hardReset()
      } catch {}
      try {
        if (activeTransport) {
          await classicReset(activeTransport)
        }
      } catch {}

      onLog?.('ESP32 复位指令已发送，正在释放串口通信权限...')
      try {
        await activeTransport.disconnect()
      } catch {}

      setDevice(null)
      setFlashSuccess(true)
      setFlashStage('固件刷写成功！若未自动亮屏请按 RST 键')
      onLog?.('🎉 固件刷写成功！若开发板屏幕未亮起，请轻按板上的 RST / EN 键复位启动。')
    } catch (e: unknown) {
      const err = e as Error
      const msg = err.message || '刷写固件失败'
      setError(msg)
      setFlashStage(`刷写失败: ${msg}`)
      onLog?.(`[ERROR] 刷写失败: ${msg}`)
      if (activeTransport) {
        try {
          await activeTransport.disconnect()
        } catch {}
      }
      setDevice(null)
      throw err
    } finally {
      setFlashing(false)
    }
  }, [isSupported, device])

  return {
    device,
    connecting,
    flashing,
    flashProgress,
    flashStage,
    flashSuccess,
    error,
    isSupported,
    connect,
    disconnect,
    flashFirmware,
  }
}
