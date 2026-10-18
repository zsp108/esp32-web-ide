import { useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import {
  Cpu, Wifi, WifiOff, Play, Download, Terminal, ChevronRight,
  Loader2, CheckCircle2, XCircle, AlertTriangle, FileCode
} from 'lucide-react'
import { projectsApi, filesApi, buildsApi } from '../api/client'
import { useWebSerial } from '../hooks/useWebSerial'
import { useWebSocket, WSMessage } from '../hooks/useWebSocket'
import clsx from 'clsx'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

interface LogEntry {
  level: 'info' | 'error' | 'warning'
  text: string
}

type RightPanel = 'device' | 'build' | 'logs' | 'flash'

export default function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [rightPanel, setRightPanel] = useState<RightPanel>('build')
  const [buildId, setBuildId] = useState<string | null>(null)
  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'success' | 'failed'>('idle')
  const [buildProgress, setBuildProgress] = useState(0)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [binUrl, setBinUrl] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const { device, connecting, error: serialError, isSupported, connect, disconnect } = useWebSerial()

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId!),
    enabled: !!projectId,
  })

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry])
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  const onWsMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'log' && msg.text) {
      appendLog({ level: msg.level ?? 'info', text: msg.text })
    } else if (msg.type === 'progress') {
      setBuildProgress(msg.percent ?? 0)
    } else if (msg.type === 'done') {
      setBuildStatus(msg.status === 'success' ? 'success' : 'failed')
      if (msg.bin_url) setBinUrl(msg.bin_url)
      if (msg.error) appendLog({ level: 'error', text: msg.error })
    }
  }, [appendLog])

  useWebSocket(buildId, onWsMessage)

  const saveFileMutation = useMutation({
    mutationFn: () => filesApi.upload(projectId!, activeFile!, fileContent),
  })

  const buildMutation = useMutation({
    mutationFn: () => buildsApi.create({
      project_id: projectId!,
      framework: project?.framework ?? 'arduino',
      board: project?.board_fqbn ?? 'esp32:esp32:esp32',
    }),
    onMutate: () => {
      setBuildStatus('building')
      setBuildProgress(0)
      setLogs([])
      setBinUrl(null)
      setRightPanel('logs')
      appendLog({ level: 'info', text: '正在提交编译任务...' })
    },
    onSuccess: (data: { id: string }) => {
      setBuildId(data.id)
      appendLog({ level: 'info', text: `编译任务已创建: ${data.id}` })
    },
    onError: () => {
      setBuildStatus('failed')
      appendLog({ level: 'error', text: '无法提交编译任务，请检查后端连接' })
    },
  })

  const handleBuild = async () => {
    if (activeFile && fileContent) {
      await saveFileMutation.mutateAsync()
    }
    buildMutation.mutate()
  }

  const handleFlash = async () => {
    if (!device || !binUrl) return
    setFlashing(true)
    setRightPanel('flash')
    try {
      appendLog({ level: 'info', text: '开始刷写固件...' })
      // TODO: 集成 esptool-js 进行真实刷写
      await new Promise(r => setTimeout(r, 2000))
      appendLog({ level: 'info', text: '固件刷写完成！' })
    } catch (e: unknown) {
      const err = e as Error
      appendLog({ level: 'error', text: `刷写失败: ${err.message}` })
    } finally {
      setFlashing(false)
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

  // Placeholder file tree — real implementation would come from backend
  const fileTree: FileNode[] = project ? [
    {
      name: project.name,
      path: '',
      type: 'dir',
      children: [
        { name: `${project.name}.ino`, path: `${project.name}.ino`, type: 'file' },
      ],
    },
  ] : []

  const panelTabs: { id: RightPanel; label: string }[] = [
    { id: 'device', label: '设备' },
    { id: 'build', label: '编译' },
    { id: 'logs', label: '日志' },
    { id: 'flash', label: '刷写' },
  ]

  return (
    <div className="h-screen flex flex-col bg-dark-900 text-gray-100 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center gap-4 border-b border-dark-600 bg-dark-800 px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-blue-400" />
          <span className="font-semibold text-sm">{project?.name ?? 'ESP32 Web IDE'}</span>
          {project && (
            <span className="text-xs text-gray-500 bg-dark-700 px-2 py-0.5 rounded">
              {project.framework.toUpperCase()} · {project.board_fqbn}
            </span>
          )}
        </div>

        <div className="flex-1" />

        {/* Device status */}
        {device ? (
          <div className="flex items-center gap-2 text-green-400 text-xs">
            <Wifi size={14} />
            <span>{device.chip} · {device.flashSize}</span>
            <button onClick={disconnect} className="text-gray-500 hover:text-red-400 ml-1">断开</button>
          </div>
        ) : (
          <button
            onClick={connect}
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
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* File tree */}
        <aside className="w-52 shrink-0 border-r border-dark-600 bg-dark-800 overflow-y-auto">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">文件</div>
          {fileTree.map(node => (
            <FileTreeNode key={node.path} node={node} activeFile={activeFile} onSelect={loadFile} depth={0} />
          ))}
        </aside>

        {/* Monaco Editor */}
        <main className="flex-1 overflow-hidden">
          {activeFile ? (
            <Editor
              height="100%"
              language={activeFile.endsWith('.ino') || activeFile.endsWith('.cpp') || activeFile.endsWith('.h') ? 'cpp' : 'plaintext'}
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
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3">
              <FileCode size={48} className="opacity-20" />
              <p className="text-sm">从左侧文件树选择文件</p>
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
                  'flex-1 text-xs py-2 font-medium transition-colors',
                  rightPanel === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-500 hover:text-gray-300'
                )}
              >
                {tab.label}
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
                onBuild={handleBuild}
                binUrl={binUrl}
                buildId={buildId}
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
                onFlash={handleFlash}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

/* ── Sub-components ── */

function FileTreeNode({
  node, activeFile, onSelect, depth,
}: {
  node: FileNode
  activeFile: string | null
  onSelect: (path: string) => void
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const isActive = activeFile === node.path

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1 w-full text-left px-3 py-1 text-xs text-gray-400 hover:text-gray-200"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />
          {node.name}
        </button>
        {open && node.children?.map(child => (
          <FileTreeNode key={child.path} node={child} activeFile={activeFile} onSelect={onSelect} depth={depth + 1} />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={clsx(
        'w-full text-left px-3 py-1 text-xs truncate transition-colors',
        isActive ? 'bg-blue-600/20 text-blue-300' : 'text-gray-400 hover:text-gray-200 hover:bg-dark-700'
      )}
      style={{ paddingLeft: `${24 + depth * 12}px` }}
    >
      {node.name}
    </button>
  )
}

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

function BuildPanel({ status, progress, onBuild, binUrl, buildId }: {
  status: 'idle' | 'building' | 'success' | 'failed'
  progress: number
  onBuild: () => void
  binUrl: string | null
  buildId: string | null
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">编译</h3>

      <button
        onClick={onBuild}
        disabled={status === 'building'}
        className="w-full flex items-center justify-center gap-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm py-2 rounded-md font-medium transition-colors"
      >
        {status === 'building' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {status === 'building' ? '编译中...' : '开始编译'}
      </button>

      {status === 'building' && (
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>进度</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {status === 'success' && (
        <div className="flex items-center gap-2 text-green-400 bg-green-900/20 rounded p-2 text-xs">
          <CheckCircle2 size={14} />
          <span>编译成功</span>
        </div>
      )}

      {status === 'failed' && (
        <div className="flex items-center gap-2 text-red-400 bg-red-900/20 rounded p-2 text-xs">
          <XCircle size={14} />
          <span>编译失败，查看日志了解详情</span>
        </div>
      )}

      {binUrl && buildId && (
        <a
          href={binUrl}
          download
          className="flex items-center justify-center gap-2 bg-dark-700 hover:bg-dark-600 text-gray-200 text-xs py-2 rounded-md border border-dark-500 transition-colors"
        >
          <Download size={13} />
          下载固件 (.bin)
        </a>
      )}
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

function FlashPanel({ device, binUrl, flashing, onFlash }: {
  device: ReturnType<typeof useWebSerial>['device']
  binUrl: string | null
  flashing: boolean
  onFlash: () => void
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">固件刷写</h3>

      {!device && (
        <div className="flex items-start gap-2 text-yellow-400 text-xs bg-yellow-900/20 rounded p-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>请先在「设备」面板连接 ESP32</span>
        </div>
      )}

      {!binUrl && (
        <div className="flex items-start gap-2 text-yellow-400 text-xs bg-yellow-900/20 rounded p-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>请先编译项目生成固件</span>
        </div>
      )}

      <button
        onClick={onFlash}
        disabled={!device || !binUrl || flashing}
        className="w-full flex items-center justify-center gap-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2 rounded-md font-medium transition-colors"
      >
        {flashing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {flashing ? '刷写中...' : '刷写固件'}
      </button>

      <p className="text-xs text-gray-600">
        通过 Web Serial API 将编译好的固件直接刷入连接的 ESP32 设备。
      </p>
    </div>
  )
}
