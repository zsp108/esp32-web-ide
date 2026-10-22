import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import {
  Cpu, Wifi, WifiOff, Play, Download, Terminal,
  Loader2, CheckCircle2, XCircle, AlertTriangle, FileCode, ArrowLeft, Square, Zap,
  FilePlus, Trash2, Settings, FileText, Code2, Pencil,
  Folder, FolderOpen, ChevronRight, ChevronDown, Database, Image, Search,
  FolderPlus, ChevronsUpDown, ChevronsDownUp, X, ArrowDown, Copy, Check,
  ShieldCheck, ShieldAlert, ShieldX, RefreshCw, GitBranch
} from 'lucide-react'
import { projectsApi, filesApi, buildsApi, boardsApi } from '../api/client'
import { useWebSerial, FlashSegment } from '../hooks/useWebSerial'
import { useWebSocket, WSMessage } from '../hooks/useWebSocket'
import clsx from 'clsx'

interface LogEntry {
  level: 'info' | 'error' | 'warning'
  text: string
}

type RightPanel = 'device' | 'build' | 'buildLogs' | 'flash' | 'flashLogs'

export interface CompatibilityReport {
  hasDevice: boolean
  isMatched: boolean
  hasWarning: boolean
  chipStatus: 'match' | 'mismatch' | 'unknown'
  expectedChip: string
  detectedChip: string
  flashStatus: 'ok' | 'warning' | 'insufficient' | 'unknown'
  expectedFlashSize: string
  detectedFlashSize: string
  binStatus: 'ok' | 'overflow' | 'unknown'
  binSizeKb?: number
  flashSizeKb?: number
  ratioPercent?: number
  suggestedBoard?: { id: string; fqbn: string; name: string }
  summary: string
  reasons: string[]
}

function normalizeChipName(name: string): string {
  return name.replace(/[-_\s]/g, '').toLowerCase()
}

function parseSizeToBytes(sizeStr?: string): number {
  if (!sizeStr) return 0
  const match = sizeStr.match(/(\d+(?:\.\d+)?)\s*(MB|M|KB|K|B|GB)/i)
  if (!match) return 0
  const val = parseFloat(match[1])
  const unit = match[2].toUpperCase()
  if (unit.startsWith('G')) return val * 1024 * 1024 * 1024
  if (unit.startsWith('M')) return val * 1024 * 1024
  if (unit.startsWith('K')) return val * 1024
  return val
}

interface FileTreeNode {
  name: string
  path: string
  isFolder: boolean
  sizeBytes?: number
  children?: FileTreeNode[]
}

function buildFileTree(files: { path: string; size_bytes?: number }[], filter: string = ''): FileTreeNode[] {
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredFiles = normalizedFilter
    ? files.filter(f => f.path.toLowerCase().includes(normalizedFilter))
    : files

  const root: FileTreeNode = { name: '', path: '', isFolder: true, children: [] }

  for (const file of filteredFiles) {
    const parts = file.path.split('/')
    let current = root
    let currentPath = ''

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isLast = i === parts.length - 1

      if (isLast) {
        current.children = current.children || []
        current.children.push({
          name: part,
          path: file.path,
          isFolder: false,
          sizeBytes: file.size_bytes,
        })
      } else {
        current.children = current.children || []
        let folder = current.children.find(c => c.isFolder && c.name === part)
        if (!folder) {
          folder = {
            name: part,
            path: currentPath,
            isFolder: true,
            children: [],
          }
          current.children.push(folder)
        }
        current = folder
      }
    }
  }

  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1
      if (!a.isFolder && b.isFolder) return 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    for (const node of nodes) {
      if (node.children) {
        sortNodes(node.children)
      }
    }
  }

  if (root.children) {
    sortNodes(root.children)
    return root.children
  }
  return []
}

function getFileIcon(filename: string) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.ino')) {
    return { Icon: Cpu, color: 'text-teal-400' }
  }
  if (lower.endsWith('.cpp') || lower.endsWith('.c') || lower.endsWith('.cc') || lower.endsWith('.cxx')) {
    return { Icon: Code2, color: 'text-blue-400' }
  }
  if (lower.endsWith('.h') || lower.endsWith('.hpp')) {
    return { Icon: FileCode, color: 'text-amber-400' }
  }
  if (lower.endsWith('.ini') || lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.lock') || lower.endsWith('.toml')) {
    return { Icon: Settings, color: 'text-purple-400' }
  }
  if (lower.endsWith('.sqlite') || lower.endsWith('.db') || lower.endsWith('.sql')) {
    return { Icon: Database, color: 'text-indigo-400' }
  }
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.svg') || lower.endsWith('.gif') || lower.endsWith('.ico')) {
    return { Icon: Image, color: 'text-pink-400' }
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    return { Icon: FileText, color: 'text-emerald-400' }
  }
  return { Icon: FileText, color: 'text-gray-400' }
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

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
  const [buildLogs, setBuildLogs] = useState<LogEntry[]>([])
  const [flashLogs, setFlashLogs] = useState<LogEntry[]>([])
  const [binUrl, setBinUrl] = useState<string | null>(null)

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
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [renamingOldPath, setRenamingOldPath] = useState('')
  const [renamingNewPath, setRenamingNewPath] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  const [buildMode, setBuildMode] = useState<'auto' | 'custom'>('auto')
  const [customCommand, setCustomCommand] = useState<string>('')
  const [selectedFramework, setSelectedFramework] = useState<string>('')
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(1200)
  const queryClient = useQueryClient()
  const [showGitSettings, setShowGitSettings] = useState(false)
  const [gitUrlInput, setGitUrlInput] = useState('')
  const [gitBranchInput, setGitBranchInput] = useState('')
  const [gitSubDirInput, setGitSubDirInput] = useState('')
  const [gitPullResult, setGitPullResult] = useState<{
    message: string
    commit_hash?: string
    commit_msg?: string
    branch?: string
    updated_files?: number
    created_files?: number
    deleted_files?: number
    total_files?: number
  } | null>(null)

  const updateProjectMutation = useMutation({
    mutationFn: (data: any) => projectsApi.update(projectId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const gitPullMutation = useMutation({
    mutationFn: (data?: { git_url?: string; branch?: string; sub_dir?: string }) =>
      projectsApi.gitPull(projectId!, data),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await refetchFiles()
      if (activeFile) {
        try {
          const updated = await filesApi.getContent(projectId!, activeFile)
          setFileContent(typeof updated === 'string' ? updated : JSON.stringify(updated))
        } catch {}
      }
      setGitPullResult(res)
    },
    onError: (err: any) => {
      const msg = err.response?.data?.details || err.response?.data?.error || err.message || 'Git Pull 失败'
      alert(`Git Pull 同步失败:\n${msg}`)
    },
  })

  const { data: projectFiles = [], refetch: refetchFiles } = useQuery<{ id: string; path: string; size_bytes: number }[]>({
    queryKey: ['files', projectId],
    queryFn: () => filesApi.list(projectId!),
    enabled: !!projectId,
  })

  // 构建文件目录树
  const fileTree = useMemo(() => {
    return buildFileTree(projectFiles, fileFilter)
  }, [projectFiles, fileFilter])

  // 初始自动展开顶层目录及当前选中文件的目录
  useEffect(() => {
    if (projectFiles.length > 0) {
      setExpandedFolders(prev => {
        const next = { ...prev }
        // 自动展开包含 activeFile 的所有父目录
        if (activeFile) {
          const parts = activeFile.split('/')
          let cur = ''
          for (let i = 0; i < parts.length - 1; i++) {
            cur = cur ? `${cur}/${parts[i]}` : parts[i]
            next[cur] = true
          }
        }
        // 若尚未展开任何目录，默认展开第 1 级顶层目录
        if (Object.keys(prev).length === 0) {
          for (const f of projectFiles) {
            const top = f.path.split('/')[0]
            if (f.path.includes('/')) {
              next[top] = true
            }
          }
        }
        return next
      })
    }
  }, [projectFiles, activeFile])

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders(prev => ({
      ...prev,
      [folderPath]: !prev[folderPath],
    }))
  }

  const expandAll = () => {
    const all: Record<string, boolean> = {}
    for (const f of projectFiles) {
      const parts = f.path.split('/')
      let cur = ''
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i]
        all[cur] = true
      }
    }
    setExpandedFolders(all)
  }

  const collapseAll = () => {
    setExpandedFolders({})
  }

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId!),
    enabled: !!projectId,
  })

  // 当项目信息加载后，若配置了自定义命令则自动同步
  useEffect(() => {
    if (project?.custom_command) {
      setCustomCommand(project.custom_command)
      setBuildMode('custom')
    }
  }, [project?.custom_command])

  // 当项目信息加载后，初始化当前选中的编译框架与超时限制
  useEffect(() => {
    if (project?.framework && !selectedFramework) {
      setSelectedFramework(project.framework)
    }
    if (project?.build_timeout_seconds) {
      setTimeoutSeconds(project.build_timeout_seconds)
    }
  }, [project?.framework, project?.build_timeout_seconds])

  // 当项目信息加载后，初始化 Git 仓库配置输入
  useEffect(() => {
    if (project) {
      setGitUrlInput(project.git_url || '')
      setGitBranchInput(project.git_branch || '')
      setGitSubDirInput(project.git_sub_dir || '')
    }
  }, [project?.git_url, project?.git_branch, project?.git_sub_dir])

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
  const currentFramework = selectedFramework || latestBuild?.framework || project?.framework || 'arduino'

  // 设备与项目匹配度检测评估
  const compatibility: CompatibilityReport = useMemo(() => {
    if (!device) {
      return {
        hasDevice: false,
        isMatched: true,
        hasWarning: false,
        chipStatus: 'unknown',
        expectedChip: '',
        detectedChip: '',
        flashStatus: 'unknown',
        expectedFlashSize: '',
        detectedFlashSize: '',
        binStatus: 'unknown',
        summary: '等待连接硬件设备',
        reasons: [],
      }
    }

    const currentBoardObj = boards.find((b: any) => (b.fqbn || b.id) === currentBoard)
    let expectedChip = currentBoardObj?.chip || ''
    if (!expectedChip) {
      const lower = currentBoard.toLowerCase()
      if (lower.includes('esp32s3')) expectedChip = 'ESP32-S3'
      else if (lower.includes('esp32c3')) expectedChip = 'ESP32-C3'
      else if (lower.includes('esp32c2')) expectedChip = 'ESP32-C2'
      else if (lower.includes('esp32c6')) expectedChip = 'ESP32-C6'
      else if (lower.includes('esp32s2')) expectedChip = 'ESP32-S2'
      else if (lower.includes('esp8266')) expectedChip = 'ESP8266'
      else expectedChip = 'ESP32'
    }

    let expectedFlashSize = currentBoardObj?.flash_size || ''
    if (!expectedFlashSize) {
      const match = currentBoard.match(/FlashSize=(\d+M)/i)
      if (match) expectedFlashSize = match[1].toUpperCase() + 'B'
      else expectedFlashSize = '4MB'
    }

    const detectedChip = device.chip || '未知'
    const detectedFlashSize = device.flashSize || '未知'

    const normExpected = normalizeChipName(expectedChip)
    const normDetected = normalizeChipName(detectedChip)
    const chipMatch = normExpected === normDetected

    const chipStatus: 'match' | 'mismatch' = chipMatch ? 'match' : 'mismatch'

    const expectedBytes = parseSizeToBytes(expectedFlashSize)
    const detectedBytes = device.flashSizeBytes || parseSizeToBytes(detectedFlashSize)

    let flashStatus: 'ok' | 'warning' | 'insufficient' | 'unknown' = 'unknown'
    if (detectedBytes > 0 && expectedBytes > 0) {
      if (detectedBytes < expectedBytes) {
        flashStatus = 'insufficient'
      } else {
        flashStatus = 'ok'
      }
    }

    let binStatus: 'ok' | 'overflow' | 'unknown' = 'unknown'
    let binSizeKb: number | undefined
    let flashSizeKb: number | undefined
    let ratioPercent: number | undefined

    if (latestBuild?.bin_size_bytes && detectedBytes > 0) {
      binSizeKb = Math.round(latestBuild.bin_size_bytes / 1024)
      flashSizeKb = Math.round(detectedBytes / 1024)
      ratioPercent = Math.min(100, Math.round((latestBuild.bin_size_bytes / detectedBytes) * 100))
      if (latestBuild.bin_size_bytes > detectedBytes) {
        binStatus = 'overflow'
      } else {
        binStatus = 'ok'
      }
    }

    let suggestedBoard: { id: string; fqbn: string; name: string } | undefined
    if (!chipMatch) {
      suggestedBoard = boards.find((b: any) => {
        const bNorm = normalizeChipName(b.chip || '')
        if (bNorm !== normDetected) return false
        if (detectedBytes > 0) {
          const bBytes = parseSizeToBytes(b.flash_size)
          return bBytes <= detectedBytes
        }
        return true
      })
    }

    const reasons: string[] = []
    if (!chipMatch) {
      reasons.push(`芯片架构不匹配：项目配置为 ${expectedChip}，实际检测到 ${detectedChip}`)
    }
    if (flashStatus === 'insufficient') {
      reasons.push(`Flash 容量可能不足：项目推荐 ${expectedFlashSize}，实际设备仅检测到 ${detectedFlashSize}`)
    }
    if (binStatus === 'overflow') {
      reasons.push(`固件产物超出物理 Flash 容量！`)
    }

    const isMatched = chipMatch && binStatus !== 'overflow'
    const hasWarning = !isMatched || flashStatus === 'insufficient'

    let summary = '硬件与项目配置完全匹配'
    if (!chipMatch) {
      summary = `芯片型号不匹配 (${detectedChip} vs ${expectedChip})`
    } else if (binStatus === 'overflow') {
      summary = '固件大小超出 Flash 限制'
    } else if (flashStatus === 'insufficient') {
      summary = `Flash 容量低于推荐 (${detectedFlashSize} < ${expectedFlashSize})`
    }

    return {
      hasDevice: true,
      isMatched,
      hasWarning,
      chipStatus,
      expectedChip,
      detectedChip,
      flashStatus,
      expectedFlashSize,
      detectedFlashSize,
      binStatus,
      binSizeKb,
      flashSizeKb,
      ratioPercent,
      suggestedBoard,
      summary,
      reasons,
    }
  }, [device, currentBoard, boards, latestBuild])

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
        if (buildLogs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setBuildLogs(lines.map((line: string) => {
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
        if (buildLogs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setBuildLogs(lines.map((line: string) => ({ level: 'warning', text: line })))
        }
      } else if (latest.status === 'failed' || latest.status === 'timeout') {
        setBuildStatus('failed')
        setBuildProgress(0)
        setBuildStage(latest.error_msg || '编译失败')
        if (buildLogs.length === 0 && latest.build_log) {
          const lines = latest.build_log.split('\n').filter(Boolean)
          setBuildLogs(lines.map((line: string) => {
            let level: 'info' | 'error' | 'warning' = 'info'
            const lower = line.toLowerCase()
            if (line.includes('[ERROR]') || lower.includes('error:')) level = 'error'
            else if (line.includes('[WARN') || lower.includes('warning:')) level = 'warning'
            return { level, text: line }
          }))
        }
      }
    }
  }, [projectBuilds, buildId, selectedBoard, buildLogs.length])

  const appendBuildLog = useCallback((entry: LogEntry) => {
    setBuildLogs(prev => [...prev, entry])
  }, [])

  const appendFlashLog = useCallback((entry: LogEntry) => {
    setFlashLogs(prev => [...prev, entry])
  }, [])

  const onWsMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'log' && msg.text) {
      appendBuildLog({ level: msg.level ?? 'info', text: msg.text })
    } else if (msg.type === 'progress') {
      if (typeof msg.percent === 'number') setBuildProgress(msg.percent)
      if (msg.stage) setBuildStage(msg.stage)
    } else if (msg.type === 'done') {
      if (msg.status === 'cancelled') {
        setBuildStatus('cancelled')
        setBuildProgress(0)
        setBuildStage('编译任务已中止')
        if (msg.error) appendBuildLog({ level: 'warning', text: `[WARN] ${msg.error}` })
      } else {
        setBuildStatus(msg.status === 'success' ? 'success' : 'failed')
        setBuildProgress(msg.status === 'success' ? 100 : 0)
        if (msg.stage) setBuildStage(msg.stage)
        if (msg.bin_url) setBinUrl(msg.bin_url)
        if (msg.error) appendBuildLog({ level: 'error', text: msg.error })
      }
      refetchBuilds()
    }
  }, [appendBuildLog, refetchBuilds])

  useWebSocket(buildId, onWsMessage)

  const saveFileMutation = useMutation({
    mutationFn: () => filesApi.upload(projectId!, activeFile!, fileContent),
  })

  const buildMutation = useMutation({
    mutationFn: () => buildsApi.create({
      project_id: projectId!,
      framework: currentFramework,
      board: currentBoard,
      board_fqbn: currentBoard,
      custom_cmd: buildMode === 'custom' ? customCommand.trim() : '',
      timeout_seconds: timeoutSeconds,
    }),
    onMutate: () => {
      setBuildStatus('building')
      setBuildProgress(10)
      setBuildStage(buildMode === 'custom' ? '正在提交自定义命令编译任务...' : '正在提交编译任务至后台...')
      setBuildLogs([])
      setBinUrl(null)
      setRightPanel('build')
      appendBuildLog({
        level: 'info',
        text: buildMode === 'custom'
          ? `[INFO] 正在提交自定义命令编译任务: ${customCommand.trim()}`
          : '正在提交编译任务至后台...',
      })
    },
    onSuccess: (data: { id: string }) => {
      setBuildId(data.id)
      appendBuildLog({ level: 'info', text: `编译任务已在后台启动: ${data.id}` })
      refetchBuilds()
    },
    onError: (err: any) => {
      setBuildStatus('failed')
      setBuildStage('提交任务失败')
      appendBuildLog({ level: 'error', text: `无法提交编译任务: ${err.response?.data?.error || err.message}` })
    },
  })

  const handleBuild = async () => {
    if (buildMode === 'custom' && !customCommand.trim()) {
      alert('请输入要执行的自定义编译命令，例如: idf.py build 或 arduino-cli compile ...')
      return
    }
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
      appendBuildLog({ level: 'warning', text: '[WARN] 用户已手动中止当前编译任务' })
      refetchBuilds()
    } catch (err: any) {
      console.error('中止任务失败:', err)
    }
  }

  const handleFlash = async () => {
    // 解析分段清单
    let segments: FlashSegment[] | undefined
    if (latestBuild?.segments && Array.isArray(latestBuild.segments) && latestBuild.segments.length > 0) {
      segments = latestBuild.segments
    } else if (latestBuild?.flash_segments) {
      try {
        const parsed = JSON.parse(latestBuild.flash_segments)
        if (Array.isArray(parsed) && parsed.length > 0) {
          segments = parsed
        }
      } catch {}
    }

    if (!binUrl && (!segments || segments.length === 0)) {
      alert('请先编译项目生成固件后再执行刷写！')
      return
    }

    if (latestBuild?.bin_size_bytes === 0) {
      alert('当前编译记录未检测到有效的固件产物 (.bin)，请先重新点击【开始编译】！')
      return
    }

    setRightPanel('flashLogs')
    try {
      appendFlashLog({ level: 'info', text: '==================== 开始固件刷写 ====================' })
      if (device && compatibility) {
        appendFlashLog({
          level: 'info',
          text: `[设备信息] 目标芯片: ${compatibility.expectedChip} ⟷ 连接设备: ${compatibility.detectedChip} (Flash: ${compatibility.detectedFlashSize})`,
        })
      }
      await flashFirmware(
        segments && segments.length > 0 ? segments : (binUrl || ''),
        undefined,
        (msg) => {
          let level: 'info' | 'warning' | 'error' = 'info'
          if (msg.includes('[ERROR]') || msg.toLowerCase().includes('error:')) level = 'error'
          else if (msg.includes('[WARN') || msg.toLowerCase().includes('warning:')) level = 'warning'
          appendFlashLog({ level, text: msg })
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

  // 开始重命名文件
  const handleStartRename = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingOldPath(filePath)
    setRenamingNewPath(filePath)
    setShowRenameModal(true)
  }

  // 确认重命名
  const handleConfirmRename = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = renamingNewPath.trim().replace(/^\/+/, '')
    if (!clean) return
    if (clean === renamingOldPath) {
      setShowRenameModal(false)
      return
    }

    try {
      await filesApi.rename(projectId!, renamingOldPath, clean)
      await refetchFiles()
      if (activeFile === renamingOldPath) {
        setActiveFile(clean)
      }
      setShowRenameModal(false)
    } catch (err: any) {
      alert(`重命名失败: ${err.response?.data?.error || err.message}`)
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
    {
      id: 'device',
      label: '设备',
      badge: device ? (
        compatibility.isMatched ? (
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="硬件匹配" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-red-400 shrink-0 animate-pulse" title="硬件不匹配" />
        )
      ) : null,
    },
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
      id: 'buildLogs',
      label: '编译日志',
      badge: buildLogs.length > 0 ? (
        <span className="text-[10px] bg-blue-950/80 text-blue-300 border border-blue-800/40 px-1.5 rounded-full font-mono">
          {buildLogs.length}
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
    {
      id: 'flashLogs',
      label: '刷写日志',
      badge: flashLogs.length > 0 ? (
        <span className="text-[10px] bg-purple-950/80 text-purple-300 border border-purple-800/40 px-1.5 rounded-full font-mono">
          {flashLogs.length}
        </span>
      ) : null,
    },
  ]

  const renderTreeNode = (node: FileTreeNode, depth = 0): React.ReactNode => {
    if (node.isFolder) {
      const isExpanded = !!fileFilter || !!expandedFolders[node.path]
      const childCount = node.children ? node.children.length : 0

      return (
        <div key={node.path} className="flex flex-col">
          <div
            onClick={() => toggleFolder(node.path)}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            className={clsx(
              'flex items-center justify-between pr-2 py-1.5 text-xs transition-colors cursor-pointer group hover:bg-dark-700/60 select-none',
              isExpanded ? 'text-gray-200 font-medium' : 'text-gray-400'
            )}
            title={`目录: ${node.path} (${childCount} 项)`}
          >
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              {isExpanded ? (
                <ChevronDown size={13} className="text-gray-400 shrink-0" />
              ) : (
                <ChevronRight size={13} className="text-gray-500 shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen size={14} className="text-amber-400 shrink-0" />
              ) : (
                <Folder size={14} className="text-amber-500/80 shrink-0" />
              )}
              <span className="truncate text-gray-300 text-xs font-mono">{node.name}</span>
            </div>

            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 shrink-0 ml-1">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setNewFileName(node.path + '/')
                  setShowNewFileModal(true)
                }}
                className="p-1 text-gray-500 hover:text-blue-400 rounded transition-colors"
                title={`在 ${node.name} 目录下新建文件`}
              >
                <FolderPlus size={12} />
              </button>
            </div>
          </div>

          {isExpanded && node.children && (
            <div className="flex flex-col">
              {node.children.map(child => renderTreeNode(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    const isActive = activeFile === node.path
    const { Icon, color: iconColor } = getFileIcon(node.name)

    return (
      <div
        key={node.path}
        onClick={() => handleSelectFile(node.path)}
        style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
        className={clsx(
          'flex items-center justify-between pr-2 py-1.5 text-xs truncate transition-all cursor-pointer group',
          isActive
            ? 'bg-blue-600/20 text-blue-300 font-medium border-l-2 border-blue-500'
            : 'text-gray-400 hover:text-gray-200 hover:bg-dark-700/50'
        )}
        title={`${node.path}${node.sizeBytes ? ` (${formatSize(node.sizeBytes)})` : ''}`}
      >
        <div className="flex items-center gap-2 min-w-0 truncate">
          <Icon size={14} className={clsx('shrink-0', iconColor)} />
          <span className="truncate font-mono">{node.name}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-1">
          {node.sizeBytes && node.sizeBytes > 1024 * 500 && (
            <span className="text-[10px] text-gray-500 group-hover:hidden font-mono">
              {formatSize(node.sizeBytes)}
            </span>
          )}
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
            <button
              onClick={(e) => handleStartRename(node.path, e)}
              className="p-1 text-gray-500 hover:text-blue-400 rounded transition-all"
              title={`重命名 ${node.name}`}
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={(e) => handleDeleteFile(node.path, e)}
              className="p-1 text-gray-500 hover:text-red-400 rounded transition-all"
              title={`删除 ${node.name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-dark-900 text-gray-100 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center flex-wrap gap-x-3 gap-y-1.5 border-b border-dark-600 bg-dark-800 px-4 py-2 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white hover:bg-dark-700 border border-dark-500 rounded px-2.5 py-1 transition-colors"
          title="返回项目列表首页"
        >
          <ArrowLeft size={14} />
          <span>返回首页</span>
        </button>

        <div className="h-4 w-px bg-dark-600 mx-1" />

        <div className="flex items-center gap-2 min-w-0">
          <Cpu size={18} className="text-blue-400 shrink-0" />
          <span className="font-semibold text-sm truncate max-w-[180px]" title={project?.name ?? 'ESP32 Web IDE'}>{project?.name ?? 'ESP32 Web IDE'}</span>
          {project && (
            <div className="flex items-center flex-wrap gap-2 ml-2">
              <span className="text-xs text-gray-400 bg-dark-700 px-2 py-0.5 rounded font-mono uppercase">
                {currentFramework}
              </span>
              <select
                value={currentBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                className="text-xs bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded px-2.5 py-1 text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer transition-colors max-w-[220px]"
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

              {/* Git 状态与同步快捷组件 */}
              {project?.git_url ? (
                <div className="flex items-center gap-1.5 bg-dark-700/80 border border-dark-500 rounded px-2 py-1 text-xs text-gray-300">
                  <GitBranch size={13} className="text-purple-400 shrink-0" />
                  <span className="font-mono text-gray-200 truncate max-w-[120px]" title={`远程仓库: ${project.git_url}\n分支: ${project.git_branch || 'main'}`}>
                    {project.git_branch || 'main'}
                  </span>
                  {project.git_commit_hash && (
                    <span className="text-gray-400 font-mono text-[11px]" title={`最后同步 Commit: ${project.git_commit_hash}`}>
                      #{project.git_commit_hash}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(`确定要从远程仓库拉取最新代码吗？\n仓库: ${project.git_url}\n分支: ${project.git_branch || 'main'}\n注意：这将从远程更新/覆盖项目文件。`)) {
                        gitPullMutation.mutate()
                      }
                    }}
                    disabled={gitPullMutation.isPending}
                    className="flex items-center gap-1 ml-1 text-xs bg-purple-900/40 hover:bg-purple-800/60 text-purple-300 border border-purple-700/50 rounded px-2 py-0.5 transition-colors disabled:opacity-50"
                    title="从远程仓库拉取最新代码并同步到 Web IDE (Git Pull)"
                  >
                    <RefreshCw size={11} className={clsx(gitPullMutation.isPending && "animate-spin")} />
                    <span>{gitPullMutation.isPending ? '同步中...' : 'Git Pull'}</span>
                  </button>
                  <button
                    onClick={() => setShowGitSettings(true)}
                    className="p-1 text-gray-400 hover:text-white rounded hover:bg-dark-600 transition-colors ml-0.5"
                    title="Git 仓库配置"
                  >
                    <Settings size={12} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowGitSettings(true)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-purple-300 bg-dark-700/50 hover:bg-dark-700 border border-dark-600 hover:border-purple-800/50 rounded px-2.5 py-1 transition-colors"
                  title="关联 Git 远程仓库以启用一键同步更新 (Git Pull)"
                >
                  <GitBranch size={13} />
                  <span>绑定 Git</span>
                </button>
              )}
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
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setRightPanel('device')}
              className="flex items-center gap-1.5 hover:opacity-85 transition-opacity"
              title="点击查看设备详情与硬件匹配预检"
            >
              <Wifi size={14} className={compatibility.isMatched ? 'text-green-400' : 'text-amber-400'} />
              <span className="text-gray-200 font-mono">{device.chip} · {device.flashSize}</span>
              {compatibility.isMatched ? (
                <span className="text-[10px] bg-green-950/80 text-green-300 border border-green-700/60 px-1.5 py-0.5 rounded font-sans">
                  匹配 ✓
                </span>
              ) : (
                <span className="text-[10px] bg-red-950/80 text-red-300 border border-red-700/60 px-1.5 py-0.5 rounded font-sans animate-pulse">
                  芯片不符 ✕
                </span>
              )}
            </button>
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
        <aside className="w-64 md:w-72 shrink-0 border-r border-dark-600 bg-dark-850 flex flex-col overflow-hidden select-none">
          <div className="flex items-center justify-between px-3 py-2 border-b border-dark-600/80 shrink-0 bg-dark-800">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">文件列表</span>
              <span className="text-[10px] text-gray-400 font-mono bg-dark-700 px-1.5 py-0.5 rounded">
                {projectFiles.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={expandAll}
                className="p-1 text-gray-400 hover:text-gray-200 hover:bg-dark-700 rounded transition-colors"
                title="全部展开"
              >
                <ChevronsUpDown size={13} />
              </button>
              <button
                onClick={collapseAll}
                className="p-1 text-gray-400 hover:text-gray-200 hover:bg-dark-700 rounded transition-colors"
                title="全部折叠"
              >
                <ChevronsDownUp size={13} />
              </button>
              <button
                onClick={() => {
                  setNewFileName('')
                  setShowNewFileModal(true)
                }}
                className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 px-1.5 py-0.5 rounded transition-colors"
                title="新建代码或配置文件 (.cpp, .h, .ini 等)"
              >
                <FilePlus size={13} />
                <span>新建</span>
              </button>
            </div>
          </div>

          {/* Quick search / filter input */}
          <div className="px-2.5 py-1.5 border-b border-dark-700/60 bg-dark-850/60 shrink-0">
            <div className="flex items-center gap-1.5 bg-dark-900 border border-dark-600/70 rounded px-2 py-1 text-xs text-gray-300 focus-within:border-blue-500 transition-colors">
              <Search size={12} className="text-gray-500 shrink-0" />
              <input
                type="text"
                value={fileFilter}
                onChange={e => setFileFilter(e.target.value)}
                placeholder="搜索文件 / 目录..."
                className="bg-transparent border-none outline-none w-full text-xs placeholder:text-gray-500 text-gray-200"
              />
              {fileFilter && (
                <button
                  onClick={() => setFileFilter('')}
                  className="text-gray-500 hover:text-gray-300 shrink-0"
                  title="清除搜索"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Hierarchical Directory Tree */}
          <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
            {fileTree.length > 0 ? (
              fileTree.map(node => renderTreeNode(node, 0))
            ) : (
              <div className="px-4 py-8 text-center text-xs text-gray-500">
                {fileFilter ? '未找到匹配的文件或目录' : '暂无文件'}
              </div>
            )}
          </div>
        </aside>

        {/* Monaco Editor */}
        <main className="flex-1 flex flex-col overflow-hidden bg-dark-900">
          {activeFile ? (
            <>
              {/* Editor sub-header / tab with breadcrumb */}
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-dark-600 bg-dark-850 shrink-0 text-xs">
                <div className="flex items-center gap-1.5 text-gray-300 font-mono min-w-0 truncate">
                  {activeFile.split('/').map((part, idx, arr) => {
                    const isLast = idx === arr.length - 1
                    const { Icon, color: iconColor } = getFileIcon(activeFile)
                    return (
                      <span key={idx} className="flex items-center gap-1 shrink-0">
                        {idx > 0 && <span className="text-gray-600">/</span>}
                        {isLast && <Icon size={13} className={clsx('shrink-0', iconColor)} />}
                        <span className={clsx(isLast ? 'text-gray-100 font-semibold' : 'text-gray-400 hover:text-gray-200')}>
                          {part}
                        </span>
                      </span>
                    )
                  })}
                  {saveSuccess && (
                    <span className="text-[11px] text-green-400 flex items-center gap-1 animate-pulse ml-2 shrink-0">
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
        <aside className="w-80 shrink-0 border-l border-dark-600 bg-dark-800 flex flex-col overflow-hidden">
          {/* Panel tabs */}
          <div className="flex border-b border-dark-600 shrink-0 overflow-x-auto">
            {panelTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setRightPanel(tab.id)}
                className={clsx(
                  'flex-1 text-[11px] py-2 px-1 font-medium transition-colors flex items-center justify-center gap-1 min-w-0 shrink-0',
                  rightPanel === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-500 hover:text-gray-300'
                )}
              >
                <span className="truncate">{tab.label}</span>
                {tab.badge}
              </button>
            ))}
          </div>

          <div className={clsx(
            'flex-1 min-h-0',
            (rightPanel === 'buildLogs' || rightPanel === 'flashLogs')
              ? 'p-2.5 flex flex-col overflow-hidden'
              : 'p-3 overflow-y-auto'
          )}>
            {rightPanel === 'device' && (
              <DevicePanel
                device={device}
                connecting={connecting}
                error={serialError}
                isSupported={isSupported}
                onConnect={connect}
                onDisconnect={disconnect}
                compatibility={compatibility}
                onSelectBoard={setSelectedBoard}
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
                onViewLogs={() => setRightPanel('buildLogs')}
                framework={currentFramework}
                onSelectFramework={(fw) => {
                  setSelectedFramework(fw)
                  if (fw === 'espidf' && timeoutSeconds < 1200) {
                    setTimeoutSeconds(1200)
                    if (projectId) {
                      updateProjectMutation.mutate({ framework: fw, build_timeout_seconds: 1200 })
                    }
                  } else if (projectId) {
                    updateProjectMutation.mutate({ framework: fw })
                  }
                }}
                timeoutSeconds={timeoutSeconds}
                onChangeTimeoutSeconds={(sec) => {
                  setTimeoutSeconds(sec)
                  if (projectId) {
                    updateProjectMutation.mutate({ build_timeout_seconds: sec })
                  }
                }}
                latestBuild={latestBuild}
                flashing={flashing}
                flashProgress={flashProgress}
                onFlashDirect={() => {
                  setRightPanel('flash')
                  handleFlash()
                }}
                buildMode={buildMode}
                onChangeBuildMode={setBuildMode}
                customCommand={customCommand}
                onChangeCustomCommand={setCustomCommand}
              />
            )}

            {rightPanel === 'buildLogs' && (
              <LogsViewer
                title="编译输出日志"
                logs={buildLogs}
                onClear={() => setBuildLogs([])}
                emptyText="等待编译任务启动，后台日志将实时流式展示..."
                accentColor="blue"
              />
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
                onConnect={() => connect((msg) => appendFlashLog({ level: 'info', text: msg }))}
                onDisconnect={disconnect}
                isSupported={isSupported}
                onViewLogs={() => setRightPanel('flashLogs')}
                compatibility={compatibility}
              />
            )}

            {rightPanel === 'flashLogs' && (
              <LogsViewer
                title="串口刷写日志"
                logs={flashLogs}
                onClear={() => setFlashLogs([])}
                emptyText="尚未执行固件刷写。点击「开始刷写」后，Web Serial 串口通信与烧录细节将实时显示在这里..."
                accentColor="purple"
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

      {/* Rename File Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-gray-100 mb-2 flex items-center gap-2">
              <Pencil size={16} className="text-blue-400" />
              <span>重命名文件</span>
            </h3>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              原文件：<code className="text-gray-200 bg-dark-900 px-1.5 py-0.5 rounded font-mono">{renamingOldPath}</code>
            </p>

            <form onSubmit={handleConfirmRename} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">新文件名 (含扩展名)</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="例如: main.cpp, main.ino, config.h"
                  value={renamingNewPath}
                  onChange={e => setRenamingNewPath(e.target.value)}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-dark-700">
                <button
                  type="button"
                  onClick={() => setShowRenameModal(false)}
                  className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-4 py-2 rounded-md font-medium transition-colors"
                >
                  确认修改
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Git Settings Modal */}
      {showGitSettings && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-100 flex items-center gap-2">
                <GitBranch size={18} className="text-purple-400" />
                <span>Git 远程仓库配置</span>
              </h3>
              <button
                onClick={() => setShowGitSettings(false)}
                className="text-gray-400 hover:text-white p-1 rounded"
              >
                <X size={16} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                updateProjectMutation.mutate({
                  git_url: gitUrlInput.trim(),
                  git_branch: gitBranchInput.trim() || 'main',
                  git_sub_dir: gitSubDirInput.trim(),
                }, {
                  onSuccess: () => setShowGitSettings(false)
                })
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Git 仓库地址 (HTTP / HTTPS)</label>
                <input
                  type="text"
                  required
                  placeholder="https://github.com/user/repository.git"
                  value={gitUrlInput}
                  onChange={e => setGitUrlInput(e.target.value)}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">分支名称 (默认 main)</label>
                  <input
                    type="text"
                    placeholder="main 或 master"
                    value={gitBranchInput}
                    onChange={e => setGitBranchInput(e.target.value)}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">子目录 (可选)</label>
                  <input
                    type="text"
                    placeholder="如: examples/blink"
                    value={gitSubDirInput}
                    onChange={e => setGitSubDirInput(e.target.value)}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500 font-mono"
                  />
                </div>
              </div>

              {project?.git_commit_hash && (
                <div className="bg-dark-900/60 border border-dark-700 rounded-lg p-3 text-xs text-gray-400 space-y-1">
                  <div className="flex justify-between">
                    <span>当前同步 Commit:</span>
                    <span className="font-mono text-purple-300 font-semibold">{project.git_commit_hash}</span>
                  </div>
                  {project.updated_at && (
                    <div className="flex justify-between">
                      <span>上次更新时间:</span>
                      <span>{new Date(project.updated_at).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pt-3 border-t border-dark-700">
                <button
                  type="button"
                  onClick={() => setShowGitSettings(false)}
                  className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  关闭
                </button>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={updateProjectMutation.isPending}
                    className="bg-dark-700 hover:bg-dark-600 text-gray-200 text-xs px-4 py-2 rounded-md font-medium transition-colors"
                  >
                    保存配置
                  </button>
                  <button
                    type="button"
                    disabled={gitPullMutation.isPending || !gitUrlInput.trim()}
                    onClick={() => {
                      updateProjectMutation.mutate({
                        git_url: gitUrlInput.trim(),
                        git_branch: gitBranchInput.trim() || 'main',
                        git_sub_dir: gitSubDirInput.trim(),
                      }, {
                        onSuccess: () => {
                          setShowGitSettings(false)
                          gitPullMutation.mutate({
                            git_url: gitUrlInput.trim(),
                            branch: gitBranchInput.trim() || 'main',
                            sub_dir: gitSubDirInput.trim(),
                          })
                        }
                      })
                    }}
                    className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs px-4 py-2 rounded-md font-medium transition-colors flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} className={clsx(gitPullMutation.isPending && "animate-spin")} />
                    <span>保存并同步 (Pull)</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Git Pull Result Modal */}
      {gitPullResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center gap-2.5 mb-3 text-green-400">
              <CheckCircle2 size={20} className="shrink-0" />
              <h3 className="text-base font-semibold text-gray-100">代码同步成功</h3>
            </div>

            <div className="space-y-2.5 text-xs text-gray-300 bg-dark-900/60 border border-dark-700 rounded-lg p-3.5 mb-4">
              <div className="flex justify-between border-b border-dark-700/60 pb-1.5">
                <span className="text-gray-400">最新 Commit:</span>
                <span className="font-mono text-purple-300 font-semibold">{gitPullResult.commit_hash || '最新'}</span>
              </div>
              {gitPullResult.commit_msg && (
                <div className="border-b border-dark-700/60 pb-1.5">
                  <span className="text-gray-400 block mb-0.5">提交说明:</span>
                  <span className="font-mono text-gray-200">{gitPullResult.commit_msg}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-400">文件变动概览:</span>
                <span className="text-gray-200">
                  更新 {gitPullResult.updated_files ?? 0} 个 · 新增 {gitPullResult.created_files ?? 0} 个 · 移除 {gitPullResult.deleted_files ?? 0} 个
                </span>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setGitPullResult(null)}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-5 py-2 rounded-md font-medium transition-colors"
              >
                好的
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ── */

function DevicePanel({
  device,
  connecting,
  error,
  isSupported,
  onConnect,
  onDisconnect,
  compatibility,
  onSelectBoard,
}: {
  device: ReturnType<typeof useWebSerial>['device']
  connecting: boolean
  error: string | null
  isSupported: boolean
  onConnect: () => void
  onDisconnect: () => void
  compatibility?: CompatibilityReport
  onSelectBoard?: (boardFqbn: string) => void
}) {
  return (
    <div className="space-y-4">
      {/* 1. 硬件连接卡片 */}
      <div className="bg-dark-800 rounded-lg p-3 border border-dark-600 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-1.5">
            <Cpu size={14} className="text-blue-400" />
            硬件串口设备
          </h3>
          {device ? (
            <span className="text-[11px] bg-green-950/80 text-green-300 border border-green-700/60 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
              <CheckCircle2 size={11} />
              已连接
            </span>
          ) : (
            <span className="text-[11px] text-gray-400">未连接</span>
          )}
        </div>

        {device ? (
          <div className="space-y-2.5 text-xs">
            <div className="bg-dark-900/80 rounded p-2.5 space-y-1.5 border border-dark-700/60 font-mono text-[11px]">
              <div className="flex justify-between">
                <span className="text-gray-400 font-sans">芯片架构:</span>
                <span className="text-green-300 font-bold">{device.chip}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400 font-sans">Flash 物理大小:</span>
                <span className="text-blue-300">{device.flashSize}</span>
              </div>
              {device.mac && (
                <div className="flex justify-between">
                  <span className="text-gray-400 font-sans">MAC 地址:</span>
                  <span className="text-gray-300">{device.mac}</span>
                </div>
              )}
            </div>

            <button
              onClick={onDisconnect}
              className="w-full text-xs text-red-400 border border-red-800/80 hover:bg-red-900/20 rounded py-1.5 transition-colors"
            >
              断开连接
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400 leading-relaxed">
              {isSupported
                ? '通过浏览器原生 Web Serial API 连接 ESP32，系统将自动读取芯片型号并进行兼容性匹配。'
                : '当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器。'}
            </p>
            <button
              onClick={onConnect}
              disabled={connecting || !isSupported}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs py-2 rounded-md transition-colors font-medium shadow-sm"
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
              {connecting ? '正在握手连接...' : '连接 ESP32 设备'}
            </button>
            {error && (
              <div className="flex items-start gap-2 text-red-400 text-xs bg-red-950/40 border border-red-800/50 rounded p-2.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. 项目与设备匹配预检卡片 (已连接时呈现) */}
      {device && compatibility && (
        <div className={clsx(
          'rounded-lg p-3 border space-y-3 transition-colors',
          !compatibility.isMatched
            ? 'bg-red-950/30 border-red-500/50'
            : compatibility.hasWarning
            ? 'bg-amber-950/30 border-amber-500/50'
            : 'bg-green-950/20 border-green-500/40'
        )}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
              {!compatibility.isMatched ? (
                <>
                  <ShieldX size={15} className="text-red-400" />
                  <span className="text-red-300">硬件不匹配</span>
                </>
              ) : compatibility.hasWarning ? (
                <>
                  <ShieldAlert size={15} className="text-amber-400" />
                  <span className="text-amber-300">配置存差异</span>
                </>
              ) : (
                <>
                  <ShieldCheck size={15} className="text-green-400" />
                  <span className="text-green-300">硬件完全匹配</span>
                </>
              )}
            </span>

            <span className={clsx(
              'text-[10px] px-2 py-0.5 rounded-full font-medium',
              !compatibility.isMatched
                ? 'bg-red-950 text-red-300 border border-red-700/60'
                : compatibility.hasWarning
                ? 'bg-amber-950 text-amber-300 border border-amber-700/60'
                : 'bg-green-950 text-green-300 border border-green-700/60'
            )}>
              {compatibility.summary}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {/* 芯片型号比对 */}
            <div className="flex items-center justify-between bg-dark-900/60 p-2 rounded border border-dark-700/40">
              <div className="space-y-0.5">
                <div className="text-[11px] text-gray-400">芯片架构</div>
                <div className="font-mono text-gray-200">
                  <span className="text-gray-400">目标: </span>{compatibility.expectedChip}
                  <span className="text-gray-500 mx-1">⟷</span>
                  <span className="text-gray-400">设备: </span>{compatibility.detectedChip}
                </div>
              </div>
              {compatibility.chipStatus === 'match' ? (
                <span className="text-[11px] text-green-400 flex items-center gap-1 font-medium">
                  <CheckCircle2 size={12} /> 匹配
                </span>
              ) : (
                <span className="text-[11px] text-red-400 flex items-center gap-1 font-medium">
                  <XCircle size={12} /> 不匹配
                </span>
              )}
            </div>

            {/* Flash 容量比对 */}
            <div className="flex items-center justify-between bg-dark-900/60 p-2 rounded border border-dark-700/40">
              <div className="space-y-0.5">
                <div className="text-[11px] text-gray-400">Flash 存储</div>
                <div className="font-mono text-gray-200">
                  <span className="text-gray-400">要求: </span>{compatibility.expectedFlashSize}
                  <span className="text-gray-500 mx-1">⟷</span>
                  <span className="text-gray-400">设备: </span>{compatibility.detectedFlashSize}
                </div>
              </div>
              {compatibility.flashStatus === 'ok' ? (
                <span className="text-[11px] text-green-400 flex items-center gap-1 font-medium">
                  <CheckCircle2 size={12} /> 充足
                </span>
              ) : compatibility.flashStatus === 'insufficient' ? (
                <span className="text-[11px] text-amber-400 flex items-center gap-1 font-medium">
                  <AlertTriangle size={12} /> 容量不足
                </span>
              ) : (
                <span className="text-[11px] text-gray-400">待测</span>
              )}
            </div>

            {/* 固件占用比对 (如果已有编译产物) */}
            {compatibility.binSizeKb && compatibility.flashSizeKb && (
              <div className="flex items-center justify-between bg-dark-900/60 p-2 rounded border border-dark-700/40">
                <div className="space-y-0.5">
                  <div className="text-[11px] text-gray-400">固件产物占用</div>
                  <div className="font-mono text-gray-200 text-[11px]">
                    {compatibility.binSizeKb} KB / {compatibility.flashSizeKb} KB ({compatibility.ratioPercent}%)
                  </div>
                </div>
                {compatibility.binStatus === 'ok' ? (
                  <span className="text-[11px] text-green-400 flex items-center gap-1 font-medium">
                    <CheckCircle2 size={12} /> 正常
                  </span>
                ) : (
                  <span className="text-[11px] text-red-400 flex items-center gap-1 font-medium">
                    <XCircle size={12} /> 溢出
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 智能切换推荐 */}
          {compatibility.suggestedBoard && onSelectBoard && (
            <div className="bg-blue-950/40 border border-blue-600/50 rounded p-2.5 space-y-2">
              <p className="text-[11px] text-blue-200 leading-relaxed">
                💡 检测到您连接的是 <strong className="text-white">{compatibility.detectedChip}</strong> 开发板，推荐将项目目标板型切换为：
                <span className="block font-medium text-blue-300 mt-0.5">{compatibility.suggestedBoard.name}</span>
              </p>
              <button
                type="button"
                onClick={() => onSelectBoard(compatibility.suggestedBoard!.fqbn || compatibility.suggestedBoard!.id)}
                className="w-full text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium py-1.5 rounded transition-colors shadow-sm flex items-center justify-center gap-1.5"
              >
                <RefreshCw size={12} />
                <span>一键切换为此开发板</span>
              </button>
            </div>
          )}

          {!compatibility.isMatched && (
            <p className="text-[11px] text-red-300 leading-relaxed bg-red-950/50 p-2 rounded border border-red-800/50">
              ⚠️ 警告：当前项目是为 <strong>{compatibility.expectedChip}</strong> 编译的，由于 CPU 指令集不同，若直接刷入 <strong>{compatibility.detectedChip}</strong> 将导致设备崩溃无法运行！
            </p>
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
  onSelectFramework,
  latestBuild,
  flashing,
  flashProgress,
  onFlashDirect,
  buildMode,
  onChangeBuildMode,
  customCommand,
  onChangeCustomCommand,
  timeoutSeconds = 1200,
  onChangeTimeoutSeconds,
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
  onSelectFramework: (framework: string) => void
  latestBuild?: any
  flashing?: boolean
  flashProgress?: number
  onFlashDirect?: () => void
  buildMode: 'auto' | 'custom'
  onChangeBuildMode: (mode: 'auto' | 'custom') => void
  customCommand: string
  onChangeCustomCommand: (cmd: string) => void
  timeoutSeconds?: number
  onChangeTimeoutSeconds: (sec: number) => void
}) {
  const boardObj = boards.find((b: any) => (b.fqbn || b.id) === currentBoard)
  const boardName = boardObj?.name || currentBoard

  // 推荐命令列表
  const quickCommands = framework === 'espidf' ? [
    'idf.py build',
    'idf.py reconfigure build',
    'idf.py fullclean && idf.py build',
  ] : [
    `arduino-cli compile --fqbn ${currentBoard} .`,
    `arduino-cli compile --fqbn ${currentBoard} --clean .`,
  ]

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
            {latestBuild?.segments && latestBuild.segments.length > 1 ? (
              <div className="flex justify-between text-xs text-gray-400">
                <span>固件架构:</span>
                <span className="text-teal-400 font-mono text-[11px]" title={latestBuild.segments.map((s: any) => `0x${s.offset.toString(16).toUpperCase()}: ${s.name} (${Math.round((s.size || 0)/1024)}KB)`).join('\n')}>
                  多段布局 ({latestBuild.segments.length} 个分段)
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
            <div className="flex justify-between items-center">
              <span>编译方式</span>
              <span className="text-gray-300 font-mono text-[11px] truncate max-w-[150px]" title={latestBuild?.custom_command || '自动编译'}>
                {latestBuild?.custom_command ? `自定义: ${latestBuild.custom_command}` : '默认自动编译'}
              </span>
            </div>
            {latestBuild?.timeout_seconds ? (
              <div className="flex justify-between items-center">
                <span>超时限制</span>
                <span className="text-gray-300 font-mono text-[11px]">
                  {Math.round(latestBuild.timeout_seconds / 60)} 分钟 ({latestBuild.timeout_seconds}s)
                </span>
              </div>
            ) : null}
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

        {/* 编译框架选择 */}
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium flex items-center justify-between">
            <span>编译框架</span>
            <span className="text-[10px] text-gray-400 font-normal">
              {(framework || 'arduino') === 'espidf' ? '使用 ESP-IDF 构建环境' : '使用 Arduino 构建环境'}
            </span>
          </label>
          <select
            value={framework || 'arduino'}
            onChange={e => onSelectFramework(e.target.value)}
            disabled={status === 'building'}
            className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="arduino">Arduino 框架 (arduino-cli)</option>
            <option value="espidf">ESP-IDF 官方框架 (idf.py)</option>
          </select>
        </div>

        {/* 开发板选择 */}
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

        {/* 编译超时限制 */}
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium flex items-center justify-between">
            <span>编译超时限制</span>
            <span className="text-[10px] text-gray-400 font-normal">
              {timeoutSeconds >= 1200 ? '适合 ESP-IDF 等大型工程' : '适合标准 Arduino 工程'}
            </span>
          </label>
          <select
            value={timeoutSeconds}
            onChange={e => onChangeTimeoutSeconds(Number(e.target.value))}
            disabled={status === 'building'}
            className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value={300}>5 分钟 (300 秒 - 简短测试)</option>
            <option value={600}>10 分钟 (600 秒 - 普通 Arduino)</option>
            <option value={900}>15 分钟 (900 秒)</option>
            <option value={1200}>20 分钟 (1200 秒 - 默认推荐，ESP-IDF)</option>
            <option value={1800}>30 分钟 (1800 秒 - 大型工程)</option>
            <option value={2700}>45 分钟 (2700 秒)</option>
            <option value={3600}>60 分钟 (3600 秒 - 极限大型工程)</option>
          </select>
        </div>

        {/* 编译模式切换 */}
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">编译执行方式</label>
          <div className="grid grid-cols-2 gap-1.5 bg-dark-900 p-1 rounded-md border border-dark-600">
            <button
              type="button"
              disabled={status === 'building'}
              onClick={() => onChangeBuildMode('auto')}
              className={`text-xs py-1.5 px-2 rounded font-medium transition-colors ${
                buildMode === 'auto'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              默认自动编译
            </button>
            <button
              type="button"
              disabled={status === 'building'}
              onClick={() => onChangeBuildMode('custom')}
              className={`text-xs py-1.5 px-2 rounded font-medium transition-colors ${
                buildMode === 'custom'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              自定义编译命令
            </button>
          </div>
        </div>

        {/* 自定义命令编辑框 */}
        {buildMode === 'custom' && (
          <div className="space-y-2 bg-dark-900/60 p-2.5 rounded-md border border-dark-600">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-1">
                <Terminal size={11} className="text-blue-400" />
                自定义执行命令
              </label>
              <span className="text-[10px] text-blue-400/90 bg-blue-950/40 px-1.5 py-0.5 rounded border border-blue-800/40">
                在项目根目录下执行
              </span>
            </div>

            <div className="relative">
              <textarea
                rows={2}
                value={customCommand}
                onChange={e => onChangeCustomCommand(e.target.value)}
                disabled={status === 'building'}
                placeholder={framework === 'espidf' ? '例如: idf.py build 或 cd platforms/esp32 && idf.py build' : '例如: arduino-cli compile --fqbn ... .'}
                className="w-full bg-dark-950 border border-dark-500 rounded p-2 text-xs font-mono text-green-300 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 resize-none leading-relaxed"
              />
            </div>
            <p className="text-[10px] text-gray-400">
              💡 命令默认从项目根目录启动（支持使用 <code className="text-blue-300">cd</code> 切换子目录），执行完后系统会自动打包固件。
            </p>

            {/* 常用命令快捷填充 */}
            <div className="space-y-1">
              <span className="text-[10px] text-gray-400">快速填入推荐命令:</span>
              <div className="flex flex-wrap gap-1">
                {quickCommands.map(cmd => (
                  <button
                    key={cmd}
                    type="button"
                    disabled={status === 'building'}
                    onClick={() => onChangeCustomCommand(cmd)}
                    className="text-[10px] font-mono bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-white px-2 py-0.5 rounded border border-dark-600 transition-colors"
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

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
              className={`w-full flex items-center justify-center gap-2 text-white text-sm py-2 rounded-md font-medium transition-colors ${
                buildMode === 'custom'
                  ? 'bg-blue-600 hover:bg-blue-500'
                  : 'bg-green-700 hover:bg-green-600'
              }`}
            >
              <Play size={14} />
              {buildMode === 'custom'
                ? (status === 'success' || status === 'failed' || status === 'cancelled' ? '重新执行自定义编译' : '执行自定义编译')
                : (status === 'success' || status === 'failed' || status === 'cancelled' ? '重新编译' : '开始编译')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function LogsViewer({
  title,
  logs,
  onClear,
  emptyText,
  accentColor = 'blue',
}: {
  title: string
  logs: LogEntry[]
  onClear: () => void
  emptyText: string
  accentColor?: 'blue' | 'purple'
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)

  // 关键：面板挂载、切换到日志面板以及有新日志推入时，瞬间对齐最新日志（最底部）
  useLayoutEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // 用户向上翻看历史日志超过 30px 时，暂停自动滚底，避免打扰阅读
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    if (isAtBottom !== autoScroll) {
      setAutoScroll(isAtBottom)
    }
  }

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      setAutoScroll(true)
    }
  }

  const handleCopy = () => {
    if (logs.length === 0) return
    const text = logs.map(l => l.text).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="h-full flex flex-col space-y-2 select-text">
      <div className="flex items-center justify-between shrink-0">
        <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-1.5 min-w-0 truncate">
          <Terminal size={13} className={clsx('shrink-0', accentColor === 'purple' ? 'text-purple-400' : 'text-blue-400')} />
          <span className="truncate">{title}</span>
          <span className="text-[10px] text-gray-400 font-mono font-normal shrink-0">
            ({logs.length})
          </span>
        </h3>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => {
              if (!autoScroll) scrollToBottom()
              else setAutoScroll(false)
            }}
            className={clsx(
              'px-1.5 py-0.5 text-[10px] rounded transition-colors flex items-center gap-0.5 border',
              autoScroll
                ? 'bg-blue-950/60 border-blue-700/60 text-blue-300'
                : 'bg-dark-700/60 border-dark-600 text-gray-400 hover:text-gray-200'
            )}
            title={autoScroll ? '已开启实时滚动到最新（点击暂停）' : '点击立即跳到底部并恢复跟随'}
          >
            <ArrowDown size={10} className={clsx(autoScroll && 'animate-bounce')} />
            <span>{autoScroll ? '最新' : '去底'}</span>
          </button>

          <button
            onClick={handleCopy}
            disabled={logs.length === 0}
            className="p-1 text-gray-400 hover:text-gray-200 bg-dark-750 hover:bg-dark-700 border border-dark-600 rounded transition-colors disabled:opacity-30"
            title="复制全部日志"
          >
            {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
          </button>

          <button
            onClick={onClear}
            disabled={logs.length === 0}
            className="p-1 text-gray-400 hover:text-red-400 bg-dark-750 hover:bg-dark-700 border border-dark-600 rounded transition-colors disabled:opacity-30"
            title="清空当前日志"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 bg-dark-950/90 border border-dark-600/70 rounded-md p-2 font-mono text-xs overflow-y-auto space-y-0.5"
      >
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-gray-500 space-y-2">
            <Terminal size={22} className="opacity-30" />
            <p className="text-[11px] leading-relaxed max-w-[200px]">{emptyText}</p>
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                'leading-relaxed break-all whitespace-pre-wrap flex items-start gap-1.5',
                log.level === 'error' && 'text-red-400 bg-red-950/25 px-1 py-0.5 rounded',
                log.level === 'warning' && 'text-yellow-400 bg-yellow-950/15 px-1 py-0.5 rounded',
                log.level === 'info' && 'text-gray-300',
              )}
            >
              <span className="text-[10px] text-gray-600 select-none shrink-0 w-5 text-right font-mono pt-0.5">
                {i + 1}
              </span>
              <span className="flex-1 min-w-0">{log.text}</span>
            </div>
          ))
        )}
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
  compatibility,
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
  compatibility?: CompatibilityReport
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
            {device.mac && (
              <div className="flex justify-between text-gray-400">
                <span>MAC 地址:</span>
                <span className="text-gray-300 font-mono text-[11px]">{device.mac}</span>
              </div>
            )}
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

      {/* 2.5 硬件与项目匹配预检条目 */}
      {device && compatibility && (
        <div className={clsx(
          'rounded-lg p-2.5 border text-xs flex items-center justify-between',
          !compatibility.isMatched
            ? 'bg-red-950/40 border-red-600/60 text-red-300'
            : compatibility.hasWarning
            ? 'bg-amber-950/40 border-amber-600/60 text-amber-300'
            : 'bg-green-950/30 border-green-600/50 text-green-300'
        )}>
          <div className="flex items-center gap-2 min-w-0 truncate">
            {!compatibility.isMatched ? (
              <ShieldX size={15} className="shrink-0 text-red-400" />
            ) : compatibility.hasWarning ? (
              <ShieldAlert size={15} className="shrink-0 text-amber-400" />
            ) : (
              <ShieldCheck size={15} className="shrink-0 text-green-400" />
            )}
            <span className="truncate text-[11px] font-medium">
              {compatibility.summary}
            </span>
          </div>

          <span className="text-[10px] shrink-0 font-mono ml-1 px-1.5 py-0.5 rounded bg-dark-900/80 border border-dark-700/60">
            {compatibility.isMatched ? '可安全刷写' : '不建议刷写'}
          </span>
        </div>
      )}

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
        className={clsx(
          'w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2.5 rounded-md font-medium transition-colors shadow-sm',
          compatibility && !compatibility.isMatched
            ? 'bg-amber-700 hover:bg-amber-600'
            : 'bg-purple-700 hover:bg-purple-600'
        )}
      >
        {flashing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
        {flashing
          ? `正在刷写中 (${flashProgress}%)...`
          : flashSuccess
          ? '再次刷写固件'
          : compatibility && !compatibility.isMatched
          ? '⚠️ 硬件不匹配（点击将弹窗确认）'
          : '一键刷写固件到 ESP32'}
      </button>

      <p className="text-[11px] text-gray-500 text-center leading-relaxed">
        通过 Web Serial 原生串口直接将固件烧录到 ESP32，并在完成后自动重启运行。
      </p>
    </div>
  )
}

