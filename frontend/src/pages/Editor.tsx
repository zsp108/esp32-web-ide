import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import {
  Cpu, Wifi, WifiOff, Play, Download, Terminal,
  Loader2, CheckCircle2, XCircle, AlertTriangle, FileCode, ArrowLeft, Square, Zap,
  FilePlus, Trash2, Settings, FileText, Code2
} from 'lucide-react'
import { projectsApi, filesApi, buildsApi, boardsApi } from '../api/client'
import { useWebSerial } from '../hooks/useWebSerial'
import { useWebSocket, WSMessage } from '../hooks/useWebSocket'
import clsx from 'clsx'

interface LogEntry {
  level: 'info' | 'error' | 'warning'
  text: string
}

type RightPanel = 'device' | 'build' | 'logs' | 'flash'

export default function EditorPage() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [rightPanel, setRightPanel] = useState<RightPanel>('build')
  const [buildId, setBuildId] = useState<string | null>(null)
  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'success' | 'failed' | 'cancelled'>('idle')
  const [buildProgress, setBuildProgress] = useState(0)
  const [buildStage, setBuildStage] = useState<string>('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [binUrl, setBinUrl] = useState<string | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const {
    device,
    connecting,
    flashing,
    flashProgress,
    flashStage,
    flashSuccess,
    error: serialError,
    isSupported,
    connect,
    disconnect,
    flashFirmware,
  } = useWebSerial()
  const [selectedBoard, setSelectedBoard] = useState<string>('')
  const [showNewFileModal, setShowNewFileModal] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)

  const { data: projectFiles = [], refetch: refetchFiles } = useQuery<{ id: string; path: string; size_bytes: number }[]>({
    queryKey: ['files', projectId],
    queryFn: () => filesApi.list(projectId!),
    enabled: !!projectId,
  })

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId!),
    enabled: !!projectId,
  })

  const { data: boards = [] } = useQuery({
    queryKey: ['boards'],
    queryFn: boardsApi.list,
  })

  // 轮询/查询项目编译历史，支持切页/返回首页后无缝恢复
  const { data: projectBuilds = [], refetch: refetchBuilds } = useQuery({
    queryKey: ['builds', projectId],
    queryFn: () => buildsApi.listByProject(projectId!),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const data = query.state.data as any[] | undefined
      const latest = data?.[0]
      return (latest?.status === 'running' || latest?.status === 'pending') ? 2500 : false
    },
  })

  const latestBuild = projectBuilds?.[0]
  const currentBoard = selectedBoard || latestBuild?.board_fqbn || project?.board_fqbn || 'esp32:esp32:esp32'

  // 从编译历史恢复状态和日志
  useEffect(() => {
    if (!projectBuilds || projectBuilds.length === 0) return
    const latest = projectBuilds[0]

    if (!buildId || buildId === latest.id) {
      setBuildId(latest.id)
      if (latest.board_fqbn && !selectedBoard) {
        setSelectedBoard(latest.board_fqbn)
      }

      if (latest.status === 'running' || latest.status === 'pending') {
        setBuildStatus('building')
        setBuildStage(latest.stage || (latest.status === 'pending' ? '等待编译队列调度...' : '后台编译进行中...'))
        if (typeof latest.progress === 'number' && latest.progress > 0) {
          setBuildProgress(latest.progress)
        } else {
          setBuildProgress(10)
        }
      } else if (latest.status === 'success') {
        setBuildStatus('success')
        setBuildProgress(100)
        setBuildStage('编译成功')
        setBinUrl(buildsApi.downloadUrl(latest.id))
        if (logs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setLogs(lines.map((line: string) => {
            let level: 'info' | 'error' | 'warning' = 'info'
            const lower = line.toLowerCase()
            if (line.includes('[ERROR]') || lower.includes('error:')) level = 'error'
            else if (line.includes('[WARN') || lower.includes('warning:')) level = 'warning'
            return { level, text: line }
          }))
        }
      } else if (latest.status === 'cancelled') {
        setBuildStatus('cancelled')
        setBuildProgress(0)
        setBuildStage(latest.error_msg || '编译任务已中止')
        if (logs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setLogs(lines.map((line: string) => ({ level: 'warning', text: line })))
        }
      } else if (latest.status === 'failed' || latest.status === 'timeout') {
        setBuildStatus('failed')
        setBuildStage(latest.error_msg || '编译失败')
        if (logs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setLogs(lines.map((line: string) => {
            let level: 'info' | 'error' | 'warning' = 'info'
            const lower = line.toLowerCase()
            if (line.includes('[ERROR]') || lower.includes('error:')) level = 'error'
            else if (line.includes('[WARN') || lower.includes('warning:')) level = 'warning'
            return { level, text: line }
          }))
        }
      }
    }
  }, [projectBuilds, buildId, selectedBoard, logs.length])

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry])
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  const onWsMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'log' && msg.text) {
      appendLog({ level: msg.level ?? 'info', text: msg.text })
    } else if (msg.type === 'progress') {
      if (typeof msg.percent === 'number') setBuildProgress(msg.percent)
      if (msg.stage) setBuildStage(msg.stage)
    } else if (msg.type === 'done') {
      if (msg.status === 'cancelled') {
        setBuildStatus('cancelled')
        setBuildProgress(0)
        setBuildStage('编译任务已中止')
        if (msg.error) appendLog({ level: 'warning', text: `[WARN] ${msg.error}` })
      } else {
        setBuildStatus(msg.status === 'success' ? 'success' : 'failed')
        setBuildProgress(msg.status === 'success' ? 100 : 0)
        if (msg.stage) setBuildStage(msg.stage)
        if (msg.bin_url) setBinUrl(msg.bin_url)
        if (msg.error) appendLog({ level: 'error', text: msg.error })
      }
      refetchBuilds()
    }
  }, [appendLog, refetchBuilds])

  useWebSocket(buildId, onWsMessage)

  const saveFileMutation = useMutation({
    mutationFn: () => filesApi.upload(projectId!, activeFile!, fileContent),
  })

  const buildMutation = useMutation({
    mutationFn: () => buildsApi.create({
      project_id: projectId!,
      framework: project?.framework ?? 'arduino',
      board: currentBoard,
      board_fqbn: currentBoard,
    }),
    onMutate: () => {
      setBuildStatus('building')
      setBuildProgress(10)
      setBuildStage('正在提交编译任务至后台...')
      setLogs([])
      setBinUrl(null)
      setRightPanel('build')
      appendLog({ level: 'info', text: '正在提交编译任务至后台...' })
    },
    onSuccess: (data: { id: string }) => {
      setBuildId(data.id)
      appendLog({ level: 'info', text: `编译任务已在后台启动: ${data.id}` })
      refetchBuilds()
    },
    onError: () => {
      setBuildStatus('failed')
      setBuildStage('提交任务失败')
      appendLog({ level: 'error', text: '无法提交编译任务，请检查后端连接' })
    },
  })

  const handleBuild = async () => {
    if (activeFile && fileContent) {
      await saveFileMutation.mutateAsync()
    }
    buildMutation.mutate()
  }

  const handleCancelBuild = async () => {
    if (!buildId) return
    try {
      await buildsApi.cancel(buildId)
      setBuildStatus('cancelled')
      setBuildProgress(0)
      setBuildStage('编译任务已中止')
      appendLog({ level: 'warning', text: '[WARN] 用户已手动中止当前编译任务' })
      refetchBuilds()
    } catch (err: any) {
      console.error('中止任务失败:', err)
    }
  }

  const handleFlash = async () => {
    if (!binUrl) {
      alert('请先编译项目生成固件后再执行刷写！')
      return
    }
    setRightPanel('flash')
    try {
      appendLog({ level: 'info', text: '==================== 开始固件刷写 ====================' })
      await flashFirmware(
        binUrl,
        undefined,
        (msg) => {
          let level: 'info' | 'warning' | 'error' = 'info'
          if (msg.includes('[ERROR]') || msg.toLowerCase().includes('error:')) level = 'error'
          else if (msg.includes('[WARN') || msg.toLowerCase().includes('warning:')) level = 'warning'
          appendLog({ level, text: msg })
        }
      )
    } catch (err: any) {
      console.error('固件刷写流程发生错误:', err)
    }
  }

  const loadFile = async (path: string) => {
    setActiveFile(path)
    try {
      const content = await filesApi.getContent(projectId!, path)
      setFileContent(typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    } catch {
      setFileContent('// 新文件')
    }
  }

  // 初始自动选择主 .ino 文件或第一个文件
  useEffect(() => {
    if (projectFiles.length > 0 && !activeFile) {
      const ino = projectFiles.find(f => f.path.endsWith('.ino'))
      const first = ino || projectFiles[0]
      if (first) {
        loadFile(first.path)
      }
    }
  }, [projectFiles, activeFile])

  // 键盘快捷键 Ctrl+S / Cmd+S 快速保存文件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (activeFile && fileContent) {
          saveFileMutation.mutate(undefined, {
            onSuccess: () => {
              setSaveSuccess(true)
              setTimeout(() => setSaveSuccess(false), 2000)
            },
          })
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeFile, fileContent, saveFileMutation])

  // 切换文件（先保存上一个已编辑的文件）
  const handleSelectFile = async (path: string) => {
    if (activeFile === path) return
    if (activeFile && fileContent) {
      try {
        await filesApi.upload(projectId!, activeFile, fileContent)
      } catch (err) {
        console.error('自动保存文件失败:', err)
      }
    }
    loadFile(path)
  }

  // 新建文件
  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault()
    let clean = newFileName.trim().replace(/^\/+/, '')
    if (!clean) return

    // 如果未带后缀，默认创建 .cpp
    if (!clean.includes('.')) {
      clean = clean + '.cpp'
    }

    let template = `// ${clean}\n`
    if (clean.endsWith('.ino')) {
      template = `#include <Arduino.h>\n\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("Hello ESP32!");\n}\n\nvoid loop() {\n  delay(1000);\n}\n`
    } else if (clean.endsWith('.cpp')) {
      template = `#include <Arduino.h>\n\n// TODO: 实现相关代码\n`
    } else if (clean.endsWith('.h') || clean.endsWith('.hpp')) {
      template = `#pragma once\n#include <Arduino.h>\n\n// TODO: 声明函数与类\n`
    } else if (clean.endsWith('.ini')) {
      template = `[env:esp32s3]\nplatform = espressif32\nframework = arduino\n\n; 依赖驱动库配置 (编译时将自动下载并缓存)\nlib_deps =\n    adafruit/Adafruit GFX Library\n    adafruit/Adafruit ST7735 and ST7789 Library\n`
    } else if (clean.endsWith('.c')) {
      template = `#include <stdio.h>\n\n// TODO: C 语言实现\n`
    }

    try {
      await filesApi.upload(projectId!, clean, template)
      await refetchFiles()
      loadFile(clean)
      setShowNewFileModal(false)
      setNewFileName('')
    } catch (err: any) {
      alert(`创建文件失败: ${err.response?.data?.error || err.message}`)
    }
  }

  // 删除文件
  const handleDeleteFile = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const isIno = filePath.endsWith('.ino')
    const totalFiles = projectFiles.length
    const inoFiles = projectFiles.filter(f => f.path.endsWith('.ino'))
    let confirmMsg = `确定要删除文件「${filePath}」吗？`
    if (totalFiles <= 1) {
      confirmMsg = `「${filePath}」是当前项目中唯一的文件，删除后项目将没有代码文件。确定要删除吗？`
    } else if (isIno && inoFiles.length === 1 && !projectFiles.some(f => f.path.endsWith('.cpp') || f.path.endsWith('.c'))) {
      confirmMsg = `「${filePath}」是当前项目中唯一的入口文件 (.ino)，若删除请确保创建新的 .ino 或 .cpp 文件以便正常编译。确定要删除吗？`
    }
    if (!window.confirm(confirmMsg)) return
    try {
      await filesApi.delete(projectId!, filePath)
      await refetchFiles()
      if (activeFile === filePath) {
        const remaining = projectFiles.filter(f => f.path !== filePath)
        if (remaining.length > 0) {
          loadFile(remaining[0].path)
        } else {
          setActiveFile(null)
          setFileContent('')
        }
      }
    } catch (err: any) {
      alert(`删除文件失败: ${err.response?.data?.error || err.message}`)
    }
  }

  const panelTabs: { id: RightPanel; label: string; badge?: React.ReactNode }[] = [
    { id: 'device', label: '设备' },
    {
      id: 'build',
      label: '编译',
      badge: buildStatus === 'building' ? (
        <span className="flex items-center gap-1 text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded-full font-mono animate-pulse">
          <Loader2 size={10} className="animate-spin" />
          {buildProgress}%
        </span>
      ) : buildStatus === 'success' ? (
        <span className="w-2 h-2 rounded-full bg-green-400" />
      ) : buildStatus === 'failed' ? (
        <span className="w-2 h-2 rounded-full bg-red-400" />
      ) : buildStatus === 'cancelled' ? (
        <span className="w-2 h-2 rounded-full bg-amber-400" />
      ) : null,
    },
    {
      id: 'logs',
      label: '日志',
      badge: logs.length > 0 ? (
        <span className="text-[10px] bg-dark-600 text-gray-400 px-1.5 rounded-full font-mono">
          {logs.length}
        </span>
      ) : null,
    },
    {
      id: 'flash',
      label: '刷写',
      badge: flashing ? (
        <span className="flex items-center gap-1 text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full font-mono animate-pulse">
          <Loader2 size={10} className="animate-spin" />
          {flashProgress}%
        </span>
      ) : flashSuccess ? (
        <span className="w-2 h-2 rounded-full bg-green-400" />
      ) : null,
    },
  ]

  return (
    <div className="h-screen flex flex-col bg-dark-900 text-gray-100 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-dark-600 bg-dark-800 px-4 py-2 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white hover:bg-dark-700 border border-dark-500 rounded px-2.5 py-1 transition-colors"
          title="返回项目列表首页"
        >
          <ArrowLeft size={14} />
          <span>返回首页</span>
        </button>

        <div className="h-4 w-px bg-dark-600 mx-1" />

        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-blue-400" />
          <span className="font-semibold text-sm">{project?.name ?? 'ESP32 Web IDE'}</span>
          {project && (
            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-gray-400 bg-dark-700 px-2 py-0.5 rounded font-mono uppercase">
                {project.framework}
              </span>
              <select
                value={currentBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                className="text-xs bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded px-2.5 py-1 text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer transition-colors"
                title="切换目标开发板"
              >
                {(boards.length > 0 ? boards : [
                  { fqbn: 'esp32:esp32:esp32', name: 'ESP32 DevKitC' },
                  { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 DevKit' },
                  { fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi', name: 'ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)' },
                  { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3' },
                  { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32-S2' },
                  { fqbn: 'waveshare:esp32s3:touch_amoled_175c', name: 'Waveshare ESP32-S3-Touch-AMOLED-1.75C' },
                ]).map((b: any) => {
                  const fqbn = b.fqbn || b.id || ''
                  return (
                    <option key={fqbn} value={fqbn}>{b.name}</option>
                  )
                })}
              </select>
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* 顶部后台编译状态提示 */}
        {buildStatus === 'building' && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setRightPanel('build')}
              className="flex items-center gap-1.5 text-xs bg-blue-900/30 text-blue-300 border border-blue-700/50 rounded px-2.5 py-1 hover:bg-blue-900/50 transition-colors animate-pulse"
              title="点击查看后台编译进度"
            >
              <Loader2 size={12} className="animate-spin text-blue-400" />
              <span>后台编译中 ({buildProgress}%)</span>
            </button>
            <button
              onClick={handleCancelBuild}
              className="flex items-center gap-1 text-xs bg-red-950/70 hover:bg-red-900 text-red-300 hover:text-white border border-red-800/60 rounded px-2 py-1 transition-colors font-medium shadow-sm"
              title="中止当前正在运行的编译任务"
            >
              <Square size={10} className="fill-current" />
              <span>中止</span>
            </button>
          </div>
        )}

        {/* Device status */}
        {device ? (
          <div className="flex items-center gap-2 text-green-400 text-xs">
            <Wifi size={14} />
            <span>{device.chip} · {device.flashSize}</span>
            <button onClick={disconnect} className="text-gray-500 hover:text-red-400 ml-1">断开</button>
          </div>
        ) : (
          <button
            onClick={() => connect()}
            disabled={connecting || !isSupported}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-dark-500 rounded px-3 py-1 transition-colors disabled:opacity-50"
          >
            {connecting ? <Loader2 size={13} className="animate-spin" /> : <WifiOff size={13} />}
            {connecting ? '连接中...' : isSupported ? '连接设备' : '不支持 Serial'}
          </button>
        )}

        {/* Build button */}
        <button
          onClick={handleBuild}
          disabled={buildStatus === 'building' || !projectId}
          className="flex items-center gap-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-4 py-1.5 rounded font-medium transition-colors"
        >
          {buildStatus === 'building'
            ? <><Loader2 size={13} className="animate-spin" />编译中...</>
            : <><Play size={13} />编译</>}
        </button>

        {/* Flash button */}
        {binUrl && (
          <button
            onClick={handleFlash}
            disabled={flashing}
            className="flex items-center gap-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs px-3.5 py-1.5 rounded font-medium transition-colors shadow-sm"
            title="一键将编译好的固件通过 Web Serial 刷写入 ESP32"
          >
            {flashing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            {flashing ? `刷写中 (${flashProgress}%)` : '刷写固件'}
          </button>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* File tree */}
        <aside className="w-56 shrink-0 border-r border-dark-600 bg-dark-800 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-dark-600/80 shrink-0 bg-dark-850">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">文件列表</span>
            <button
              onClick={() => setShowNewFileModal(true)}
              className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 px-2 py-0.5 rounded transition-colors"
              title="新建代码或配置文件 (.cpp, .h, .ini 等)"
            >
              <FilePlus size={13} />
              <span>新建</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
            {projectFiles.map(file => {
              const isActive = activeFile === file.path
              let Icon = FileText
              let iconColor = 'text-gray-400'
              if (file.path.endsWith('.ino')) {
                Icon = Cpu
                iconColor = 'text-teal-400'
              } else if (file.path.endsWith('.cpp') || file.path.endsWith('.c')) {
                Icon = Code2
                iconColor = 'text-blue-400'
              } else if (file.path.endsWith('.h') || file.path.endsWith('.hpp')) {
                Icon = FileCode
                iconColor = 'text-amber-400'
              } else if (file.path.endsWith('.ini')) {
                Icon = Settings
                iconColor = 'text-purple-400'
              }

              return (
                <div
                  key={file.path}
                  onClick={() => handleSelectFile(file.path)}
                  className={clsx(
                    'flex items-center justify-between px-3 py-1.5 text-xs truncate transition-colors cursor-pointer group',
                    isActive ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-gray-400 hover:text-gray-200 hover:bg-dark-700/60'
                  )}
                >
                  <div className="flex items-center gap-2 truncate min-w-0">
                    <Icon size={14} className={clsx('shrink-0', iconColor)} />
                    <span className="truncate">{file.path}</span>
                  </div>
                  <button
                    onClick={(e) => handleDeleteFile(file.path, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-red-400 rounded transition-all shrink-0 ml-1"
                    title={`删除 ${file.path}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        </aside>

        {/* Monaco Editor */}
        <main className="flex-1 flex flex-col overflow-hidden bg-dark-900">
          {activeFile ? (
            <>
              {/* Editor sub-header / tab */}
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-dark-600 bg-dark-850 shrink-0 text-xs">
                <div className="flex items-center gap-2 text-gray-300 font-mono">
                  <span className="text-gray-100 font-semibold">{activeFile}</span>
                  {saveSuccess && (
                    <span className="text-[11px] text-green-400 flex items-center gap-1 animate-pulse">
                      <CheckCircle2 size={11} /> 已保存
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (activeFile && fileContent) {
                      saveFileMutation.mutate(undefined, {
                        onSuccess: () => {
                          setSaveSuccess(true)
                          setTimeout(() => setSaveSuccess(false), 2000)
                        },
                      })
                    }
                  }}
                  disabled={saveFileMutation.isPending}
                  className="text-[11px] text-gray-400 hover:text-white bg-dark-700 hover:bg-dark-600 border border-dark-500 px-2 py-0.5 rounded transition-colors"
                  title="保存当前文件 (Ctrl+S)"
                >
                  {saveFileMutation.isPending ? '保存中...' : '保存 (Ctrl+S)'}
                </button>
              </div>

              <div className="flex-1 overflow-hidden">
                <Editor
                  height="100%"
                  language={
                    activeFile.endsWith('.ini') ? 'ini' :
                    (activeFile.endsWith('.ino') || activeFile.endsWith('.cpp') || activeFile.endsWith('.c') || activeFile.endsWith('.h') || activeFile.endsWith('.hpp')) ? 'cpp' :
                    activeFile.endsWith('.json') ? 'json' :
                    activeFile.endsWith('.md') ? 'markdown' :
                    'plaintext'
                  }
                  theme="vs-dark"
                  value={fileContent}
                  onChange={v => setFileContent(v ?? '')}
                  options={{
                    fontSize: 14,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3">
              <FileCode size={48} className="opacity-20" />
              <p className="text-sm">从左侧选择文件或点击「新建」添加代码与配置</p>
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="w-72 shrink-0 border-l border-dark-600 bg-dark-800 flex flex-col overflow-hidden">
          {/* Panel tabs */}
          <div className="flex border-b border-dark-600 shrink-0">
            {panelTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setRightPanel(tab.id)}
                className={clsx(
                  'flex-1 text-xs py-2 font-medium transition-colors flex items-center justify-center gap-1.5',
                  rightPanel === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-500 hover:text-gray-300'
                )}
              >
                <span>{tab.label}</span>
                {tab.badge}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {rightPanel === 'device' && (
              <DevicePanel
                device={device}
                connecting={connecting}
                error={serialError}
                isSupported={isSupported}
                onConnect={connect}
                onDisconnect={disconnect}
              />
            )}

            {rightPanel === 'build' && (
              <BuildPanel
                status={buildStatus}
                progress={buildProgress}
                stage={buildStage}
                onBuild={handleBuild}
                onCancel={handleCancelBuild}
                binUrl={binUrl}
                buildId={buildId}
                boards={boards}
                currentBoard={currentBoard}
                onSelectBoard={setSelectedBoard}
                onViewLogs={() => setRightPanel('logs')}
                framework={project?.framework}
                latestBuild={latestBuild}
                flashing={flashing}
                flashProgress={flashProgress}
                onFlashDirect={() => {
                  setRightPanel('flash')
                  handleFlash()
                }}
              />
            )}

            {rightPanel === 'logs' && (
              <LogsPanel logs={logs} logsEndRef={logsEndRef} />
            )}

            {rightPanel === 'flash' && (
              <FlashPanel
                device={device}
                binUrl={binUrl}
                flashing={flashing}
                flashProgress={flashProgress}
                flashStage={flashStage}
                flashSuccess={flashSuccess}
                error={serialError}
                latestBuild={latestBuild}
                onFlash={handleFlash}
                onConnect={() => connect((msg) => appendLog({ level: 'info', text: msg }))}
                onDisconnect={disconnect}
                isSupported={isSupported}
                onViewLogs={() => setRightPanel('logs')}
              />
            )}
          </div>
        </aside>
      </div>

      {/* New File Modal */}
      {showNewFileModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-gray-100 mb-2">新建文件</h3>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              支持新建代码文件（<code className="text-blue-300">.cpp</code>, <code className="text-amber-300">.h</code>, <code className="text-teal-300">.ino</code>）、配置文件（<code className="text-purple-300">platformio.ini</code>, <code className="text-purple-300">config.ini</code>）或依赖清单（<code className="text-green-300">libraries.txt</code>）。
            </p>

            <form onSubmit={handleCreateFile} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">文件路径 / 名称</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="例如: display.cpp, display.h, platformio.ini"
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>

              {/* Quick suggestion tags */}
              <div className="space-y-1.5">
                <span className="text-[11px] text-gray-500">常用模板推荐：</span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'display.cpp',
                    'display.h',
                    'platformio.ini',
                    'libraries.txt',
                    'config.h',
                  ].map(suggest => (
                    <button
                      key={suggest}
                      type="button"
                      onClick={() => setNewFileName(suggest)}
                      className="text-[11px] bg-dark-700 hover:bg-dark-600 text-gray-300 px-2 py-0.5 rounded border border-dark-500 transition-colors font-mono"
                    >
                      + {suggest}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-dark-700">
                <button
                  type="button"
                  onClick={() => setShowNewFileModal(false)}
                  className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-4 py-2 rounded-md font-medium transition-colors"
                >
                  确认创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ── */

function DevicePanel({ device, connecting, error, isSupported, onConnect, onDisconnect }: {
  device: ReturnType<typeof useWebSerial>['device']
  connecting: boolean
  error: string | null
  isSupported: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">设备连接</h3>
      {device ? (
        <div className="bg-dark-700 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-green-400">
            <CheckCircle2 size={14} />
            <span className="text-sm font-medium">已连接</span>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>芯片: <span className="text-gray-200">{device.chip}</span></div>
            <div>Flash: <span className="text-gray-200">{device.flashSize}</span></div>
          </div>
          <button
            onClick={onDisconnect}
            className="w-full mt-2 text-xs text-red-400 border border-red-800 rounded px-3 py-1.5 hover:bg-red-900/20 transition-colors"
          >
            断开连接
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {isSupported
              ? '点击下方按钮通过 Web Serial API 连接 ESP32'
              : '浏览器不支持 Web Serial API，请使用 Chrome 或 Edge'}
          </p>
          <button
            onClick={onConnect}
            disabled={connecting || !isSupported}
            className="w-full flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm py-2 rounded-md transition-colors"
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
            {connecting ? '连接中...' : '连接设备'}
          </button>
          {error && (
            <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 rounded p-2">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BuildPanel({
  status,
  progress,
  stage,
  onBuild,
  onCancel,
  binUrl,
  buildId,
  boards,
  currentBoard,
  onSelectBoard,
  onViewLogs,
  framework,
  latestBuild,
  flashing,
  flashProgress,
  onFlashDirect,
}: {
  status: 'idle' | 'building' | 'success' | 'failed' | 'cancelled'
  progress: number
  stage: string
  onBuild: () => void
  onCancel: () => void
  binUrl: string | null
  buildId: string | null
  boards: any[]
  currentBoard: string
  onSelectBoard: (board: string) => void
  onViewLogs: () => void
  framework?: string
  latestBuild?: any
  flashing?: boolean
  flashProgress?: number
  onFlashDirect?: () => void
}) {
  const boardObj = boards.find((b: any) => (b.fqbn || b.id) === currentBoard)
  const boardName = boardObj?.name || currentBoard

  return (
    <div className="space-y-4">
      {/* 1. 实时任务与进度状态卡片 */}
      {status === 'building' && (
        <div className="bg-blue-950/40 border border-blue-500/40 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-blue-400">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-xs font-semibold uppercase tracking-wider">后台编译进行中</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-blue-300">{Math.max(progress, 10)}%</span>
              <button
                onClick={onCancel}
                className="text-[11px] text-red-400 hover:text-red-200 bg-red-950/60 hover:bg-red-900/80 border border-red-700/60 px-2 py-0.5 rounded transition-colors flex items-center gap-1 font-medium"
                title="中止当前编译任务"
              >
                <Square size={9} className="fill-current" />
                <span>中止</span>
              </button>
            </div>
          </div>

          <div className="h-2 bg-dark-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-600 to-cyan-400 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(progress, 5)}%` }}
            />
          </div>

          <div className="text-[11px] text-gray-300 flex items-center justify-between">
            <span className="truncate">{stage || '正在编译中...'}</span>
            <button
              onClick={onViewLogs}
              className="text-blue-400 hover:text-blue-200 shrink-0 ml-2 underline text-[11px]"
            >
              实时日志 →
            </button>
          </div>

          <p className="text-[11px] text-gray-400 leading-relaxed bg-dark-800/80 p-2 rounded border border-dark-600/50">
            ℹ️ 编译任务在服务器 Docker 容器中独立运行。您可以返回首页或切换到其他项目，任务不会中断。
          </p>
        </div>
      )}

      {status === 'success' && (
        <div className="bg-green-950/30 border border-green-500/40 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400">
              <CheckCircle2 size={16} />
              <span className="text-xs font-semibold uppercase tracking-wider">编译成功</span>
            </div>
            {latestBuild?.duration_ms && (
              <span className="text-[11px] text-gray-400 font-mono">
                {(latestBuild.duration_ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          <div className="text-xs text-gray-300 space-y-1">
            {latestBuild?.bin_size_bytes ? (
              <div className="flex justify-between text-xs text-gray-400">
                <span>固件大小:</span>
                <span className="text-gray-200 font-mono">
                  {(latestBuild.bin_size_bytes / 1024).toFixed(1)} KB
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onFlashDirect}
              disabled={flashing}
              className="flex-1 flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs py-2 rounded font-medium transition-colors shadow-sm"
              title="一键将编译好的固件通过 Web Serial 刷写入 ESP32"
            >
              {flashing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
              {flashing ? `刷写中 (${flashProgress}%)` : '一键刷写固件'}
            </button>
            {binUrl && (
              <a
                href={binUrl}
                download
                className="flex items-center justify-center gap-1 bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs px-2.5 py-2 rounded border border-dark-500 transition-colors"
                title="下载编译好的固件 .bin 文件"
              >
                <Download size={13} />
                下载
              </a>
            )}
            <button
              onClick={onViewLogs}
              className="flex items-center justify-center gap-1 bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs px-2.5 py-2 rounded border border-dark-500 transition-colors"
            >
              日志
            </button>
          </div>
        </div>
      )}

      {status === 'failed' && (
        <div className="bg-red-950/30 border border-red-500/40 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-red-400">
              <XCircle size={16} />
              <span className="text-xs font-semibold uppercase tracking-wider">编译未通过</span>
            </div>
          </div>
          <p className="text-xs text-red-300 line-clamp-3 bg-red-950/40 p-2 rounded font-mono text-[11px]">
            {latestBuild?.error_msg || stage || '编译过程中出错，请查看日志详情'}
          </p>
          <button
            onClick={onViewLogs}
            className="w-full flex items-center justify-center gap-1 text-xs text-red-300 hover:text-red-200 bg-red-900/30 hover:bg-red-900/50 py-1.5 rounded transition-colors"
          >
            查看编译日志详情 →
          </button>
        </div>
      )}

      {status === 'cancelled' && (
        <div className="bg-amber-950/30 border border-amber-500/40 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-400">
              <Square size={14} className="fill-current" />
              <span className="text-xs font-semibold uppercase tracking-wider">编译任务已中止</span>
            </div>
          </div>
          <p className="text-xs text-amber-300/80 bg-amber-950/40 p-2 rounded font-mono text-[11px]">
            {latestBuild?.error_msg || stage || '当前任务已被手动中止，可随时重新发起编译'}
          </p>
          <button
            onClick={onViewLogs}
            className="w-full flex items-center justify-center gap-1 text-xs text-amber-300 hover:text-amber-200 bg-amber-900/30 hover:bg-amber-900/50 py-1.5 rounded transition-colors"
          >
            查看历史日志 →
          </button>
        </div>
      )}

      {/* 2. 当前编译任务详细信息 */}
      {buildId && (
        <div className="bg-dark-800 rounded-lg p-3 border border-dark-600 space-y-2">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">当前任务信息</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div className="flex justify-between items-center">
              <span>任务编号</span>
              <span className="font-mono text-gray-300 text-[11px]" title={buildId}>
                {buildId.slice(0, 8)}...{buildId.slice(-4)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span>目标开发板</span>
              <span className="text-gray-300 text-right truncate max-w-[140px]" title={boardName}>
                {boardName}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span>编译框架</span>
              <span className="text-gray-300 uppercase font-mono text-[11px]">
                {framework || 'arduino'}
              </span>
            </div>
            {latestBuild?.created_at && (
              <div className="flex justify-between items-center">
                <span>提交时间</span>
                <span className="text-gray-300 text-[11px]">
                  {new Date(latestBuild.created_at).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. 编译设置与触发按钮 */}
      <div className="bg-dark-800 rounded-lg p-3 border border-dark-600 space-y-3">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">编译设置</h4>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">目标开发板</label>
          <select
            value={currentBoard}
            onChange={e => onSelectBoard(e.target.value)}
            disabled={status === 'building'}
            className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            {(boards.length > 0 ? boards : [
              { fqbn: 'esp32:esp32:esp32', name: 'ESP32 DevKitC' },
              { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 DevKit' },
              { fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi', name: 'ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)' },
              { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3' },
              { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32-S2' },
              { fqbn: 'waveshare:esp32s3:touch_amoled_175c', name: 'Waveshare ESP32-S3-Touch-AMOLED-1.75C' },
            ]).map((b: any) => {
              const fqbn = b.fqbn || b.id || ''
              return (
                <option key={fqbn} value={fqbn}>{b.name}</option>
              )
            })}
          </select>
        </div>

        <div>
          {status === 'building' ? (
            <div className="flex gap-2">
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 bg-blue-900/60 text-blue-200 text-xs py-2 rounded-md font-medium cursor-not-allowed"
              >
                <Loader2 size={13} className="animate-spin" />
                后台编译中 ({Math.max(progress, 10)}%)
              </button>
              <button
                onClick={onCancel}
                title="中止当前编译任务"
                className="px-3 py-2 bg-red-950/80 hover:bg-red-900 text-red-300 hover:text-white text-xs rounded-md border border-red-700/60 transition-colors flex items-center gap-1.5 shrink-0 font-medium"
              >
                <Square size={12} className="fill-current" />
                中止编译
              </button>
              <button
                onClick={onBuild}
                title="重新发起编译"
                className="px-3 py-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-white text-xs rounded-md border border-dark-500 transition-colors shrink-0"
              >
                重试
              </button>
            </div>
          ) : (
            <button
              onClick={onBuild}
              className="w-full flex items-center justify-center gap-2 bg-green-700 hover:bg-green-600 text-white text-sm py-2 rounded-md font-medium transition-colors"
            >
              <Play size={14} />
              {status === 'success' || status === 'failed' || status === 'cancelled' ? '重新编译' : '开始编译'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function LogsPanel({ logs, logsEndRef }: {
  logs: LogEntry[]
  logsEndRef: React.RefObject<HTMLDivElement>
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
        <Terminal size={12} />
        编译日志
      </h3>
      <div className="bg-dark-900 rounded-md p-2 font-mono text-xs space-y-0.5 max-h-[calc(100vh-200px)] overflow-y-auto">
        {logs.length === 0 ? (
          <span className="text-gray-600">等待编译...</span>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                log.level === 'error' && 'text-red-400',
                log.level === 'warning' && 'text-yellow-400',
                log.level === 'info' && 'text-gray-300',
              )}
            >
              {log.text}
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}

function FlashPanel({
  device,
  binUrl,
  flashing,
  flashProgress,
  flashStage,
  flashSuccess,
  error,
  latestBuild,
  onFlash,
  onConnect,
  onDisconnect,
  isSupported,
  onViewLogs,
}: {
  device: ReturnType<typeof useWebSerial>['device']
  binUrl: string | null
  flashing: boolean
  flashProgress: number
  flashStage: string
  flashSuccess: boolean
  error: string | null
  latestBuild?: any
  onFlash: () => void
  onConnect: () => void
  onDisconnect: () => void
  isSupported: boolean
  onViewLogs: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
          <Zap size={13} className="text-purple-400" />
          固件刷写 (Web Serial)
        </h3>
        {onViewLogs && (
          <button
            onClick={onViewLogs}
            className="text-[11px] text-blue-400 hover:text-blue-300 underline"
          >
            刷写日志 →
          </button>
        )}
      </div>

      {/* 1. 固件状态卡片 */}
      <div className="bg-dark-800 rounded-lg p-3 border border-dark-600 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">固件产物</span>
          {binUrl ? (
            <span className="text-[11px] bg-green-950/80 text-green-300 border border-green-700/60 px-2 py-0.5 rounded-full font-medium">
              固件已就绪 (.bin)
            </span>
          ) : (
            <span className="text-[11px] bg-yellow-950/80 text-yellow-300 border border-yellow-700/60 px-2 py-0.5 rounded-full font-medium">
              尚未编译
            </span>
          )}
        </div>
        {binUrl ? (
          <div className="text-xs text-gray-300 space-y-1 pt-1">
            {latestBuild?.bin_size_bytes && (
              <div className="flex justify-between text-gray-400">
                <span>大小:</span>
                <span className="font-mono text-gray-200">
                  {(latestBuild.bin_size_bytes / 1024).toFixed(1)} KB
                </span>
              </div>
            )}
            <div className="flex justify-between text-gray-400">
              <span>刷写偏移地址:</span>
              <span className="font-mono text-gray-200">0x0 (包含引导扇区)</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-yellow-400/90 pt-1">
            请先在「编译」面板点击【开始编译】，生成固件后即可刷入硬件。
          </p>
        )}
      </div>

      {/* 2. 串口设备状态卡片 */}
      <div className="bg-dark-800 rounded-lg p-3 border border-dark-600 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">硬件设备</span>
          {device ? (
            <span className="text-[11px] bg-green-950/80 text-green-300 border border-green-700/60 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
              <CheckCircle2 size={10} />
              已连接
            </span>
          ) : (
            <span className="text-[11px] text-gray-400">未连接</span>
          )}
        </div>
        {device ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between text-gray-400">
              <span>芯片型号:</span>
              <span className="text-gray-200 font-medium">{device.chip}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Flash 大小:</span>
              <span className="text-gray-200">{device.flashSize}</span>
            </div>
            <button
              onClick={onDisconnect}
              className="w-full mt-1.5 text-xs text-red-400 border border-red-800/80 rounded py-1 hover:bg-red-900/20 transition-colors"
            >
              断开连接
            </button>
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-gray-400">
              {isSupported
                ? '支持点击直接刷写，系统将弹出选择串口；或点击下方预先连接：'
                : '当前浏览器不支持 Web Serial，请使用 Chrome 或 Edge 浏览器。'}
            </p>
            {isSupported && (
              <button
                onClick={onConnect}
                className="w-full text-xs text-gray-300 bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded py-1.5 transition-colors"
              >
                选择并连接 ESP32 串口
              </button>
            )}
          </div>
        )}
      </div>

      {/* 3. 刷写进度与状态展示 */}
      {flashing && (
        <div className="bg-purple-950/40 border border-purple-500/50 rounded-lg p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-purple-300">
              <Loader2 size={16} className="animate-spin text-purple-400" />
              <span className="text-xs font-semibold">正在刷写固件到 ESP32...</span>
            </div>
            <span className="text-xs font-mono font-bold text-purple-200">{flashProgress}%</span>
          </div>

          <div className="h-2.5 bg-dark-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-600 to-indigo-400 rounded-full transition-all duration-200"
              style={{ width: `${Math.max(flashProgress, 5)}%` }}
            />
          </div>

          <p className="text-xs text-purple-200 truncate font-mono text-[11px]">
            {flashStage || '正在向 ESP32 烧录数据...'}
          </p>
        </div>
      )}

      {/* 4. 成功反馈 */}
      {flashSuccess && !flashing && (
        <div className="bg-green-950/40 border border-green-500/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-green-400">
            <CheckCircle2 size={16} />
            <span className="text-xs font-semibold">固件刷写成功！</span>
          </div>
          <p className="text-xs text-green-300/90 leading-relaxed">
            固件数据已完整烧录至 ESP32 内部 Flash，设备已自动完成硬件复位并启动运行新固件。
          </p>
        </div>
      )}

      {/* 5. 失败反馈 */}
      {error && !flashing && (
        <div className="bg-red-950/40 border border-red-500/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-red-400">
            <XCircle size={16} />
            <span className="text-xs font-semibold">刷写失败</span>
          </div>
          <p className="text-xs text-red-300 font-mono text-[11px] bg-red-950/50 p-2 rounded">
            {error}
          </p>
          <div className="text-[11px] text-gray-400 space-y-1 bg-dark-800/80 p-2 rounded border border-dark-600/50">
            <p className="font-semibold text-gray-300">💡 常见排查方法：</p>
            <p>1. 请确保串口没有被其他软件（VS Code / Arduino IDE / 串口助手）占用。</p>
            <p>2. 部分 ESP32-S3 开发板需手动按住板载【BOOT】按键再点刷写，出现连接后再松手。</p>
          </div>
        </div>
      )}

      {/* 6. 主操作按钮 */}
      <button
        onClick={onFlash}
        disabled={!binUrl || flashing || !isSupported}
        className="w-full flex items-center justify-center gap-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2.5 rounded-md font-medium transition-colors shadow-sm"
      >
        {flashing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
        {flashing
          ? `正在刷写中 (${flashProgress}%)...`
          : flashSuccess
          ? '再次刷写固件'
          : '一键刷写固件到 ESP32'}
      </button>

      <p className="text-[11px] text-gray-500 text-center leading-relaxed">
        通过 Web Serial 原生串口直接将固件烧录到 ESP32，并在完成后自动重启运行。
      </p>
    </div>
  )
}

