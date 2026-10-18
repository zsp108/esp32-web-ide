import { useState, useCallback } from 'react'
import { ESPLoader, Transport, classicReset, usbJTAGSerialReset } from 'esptool-js'
import axios from 'axios'

export interface FlashSegment {
  offset: number
  name: string
  size?: number
  url: string
}

export interface DeviceInfo {
  chip: string
  flashSize: string
  flashSizeBytes?: number
  mac?: string
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
      let flashSizeBytes: number | undefined
      try {
        const flashKb = await esploader.getFlashSize()
        if (typeof flashKb === 'number' && flashKb > 0) {
          flashSizeBytes = flashKb * 1024
          flashSizeStr = flashKb >= 1024 ? `${Math.round(flashKb / 1024)}MB` : `${flashKb}KB`
        }
      } catch {}

      let macStr: string | undefined
      try {
        if (esploader.chip && typeof (esploader.chip as any).readMac === 'function') {
          macStr = await (esploader.chip as any).readMac(esploader)
        }
      } catch {}

      onLog?.(`连接成功: ${chip} (Flash 大小: ${flashSizeStr}${macStr ? `, MAC: ${macStr}` : ''})`)
      setDevice({
        chip,
        flashSize: flashSizeStr,
        flashSizeBytes,
        mac: macStr,
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
    target: string | FlashSegment[],
    onProgress?: (pct: number) => void,
    onLog?: (msg: string) => void,
  ) => {
    if (!isSupported) {
      throw new Error('当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器')
    }

    setFlashing(true)
    setFlashProgress(0)
    setFlashStage('正在解析固件清单...')
    setFlashSuccess(false)
    setError(null)

    let segments: FlashSegment[] = []
    if (typeof target === 'string') {
      segments = [{ offset: 0x0, name: 'firmware.bin', url: target }]
    } else if (Array.isArray(target) && target.length > 0) {
      segments = target
    } else {
      throw new Error('无效的固件烧录参数')
    }

    const blobToBinary = (blob: Blob): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
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
    }

    let activeTransport: Transport | null = null
    let activeLoader: ESPLoader | null = null

    try {
      if (segments.length > 1) {
        onLog?.(`[固件分析] 检测到多段式固件架构 (${segments.length} 个分段):`)
        segments.forEach((seg) => {
          const hexOffset = '0x' + seg.offset.toString(16).toUpperCase()
          const sizeStr = seg.size ? ` (${(seg.size / 1024).toFixed(1)} KB)` : ''
          onLog?.(`  ├─ [${hexOffset}] ${seg.name}${sizeStr}`)
        })
      } else {
        const hexOffset = '0x' + segments[0].offset.toString(16).toUpperCase()
        onLog?.(`[固件分析] 检测到单镜像固件 (写入基地址: ${hexOffset})`)
      }

      setFlashStage(`正在下载固件产物...`)
      const fileArray: Array<{ data: string; address: number }> = []

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const hexOffset = '0x' + seg.offset.toString(16).toUpperCase()
        onLog?.(`正在从服务器获取固件分段 [${hexOffset}] ${seg.name}...`)
        setFlashStage(`正在下载分段 ${seg.name} (${i + 1}/${segments.length})...`)
        const resp = await axios.get(seg.url, { responseType: 'blob' })
        const blob = resp.data as Blob
        const binStr = await blobToBinary(blob)
        fileArray.push({
          data: binStr,
          address: seg.offset,
        })
      }
      onLog?.(`所有固件分段已加载完毕 (${fileArray.length} 个)，准备连接串口设备...`)

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
        const chip = await activeLoader.main()
        let flashSizeStr = '未知'
        let flashSizeBytes: number | undefined
        try {
          const flashKb = await activeLoader.getFlashSize()
          if (typeof flashKb === 'number' && flashKb > 0) {
            flashSizeBytes = flashKb * 1024
            flashSizeStr = flashKb >= 1024 ? `${Math.round(flashKb / 1024)}MB` : `${flashKb}KB`
          }
        } catch {}
        let macStr: string | undefined
        try {
          if (activeLoader.chip && typeof (activeLoader.chip as any).readMac === 'function') {
            macStr = await (activeLoader.chip as any).readMac(activeLoader)
          }
        } catch {}
        onLog?.(`已成功握手，识别芯片型号: ${chip} (Flash: ${flashSizeStr}${macStr ? `, MAC: ${macStr}` : ''})`)
        setDevice({
          chip,
          flashSize: flashSizeStr,
          flashSizeBytes,
          mac: macStr,
          port,
          transport: activeTransport,
          esploader: activeLoader,
        })
      }

      onLog?.(`开始向 ESP32 Flash 写入 ${fileArray.length} 个分段数据...`)
      setFlashStage('正在擦除并烧录固件...')

      await activeLoader.writeFlash({
        fileArray,
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
