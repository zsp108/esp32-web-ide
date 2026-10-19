import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Cpu, Folder, ChevronRight, Loader2, AlertCircle, GitBranch, CheckCircle2, XCircle, Square, Trash2, UploadCloud, FileArchive } from 'lucide-react'
import { projectsApi, boardsApi, importApi } from '../api/client'

interface Board {
  id?: string
  fqbn?: string
  name: string
  framework?: string | string[]
  idf_target?: string
}

interface LatestBuild {
  id: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled'
  duration_ms?: number
  created_at?: string
  board_fqbn?: string
}

interface Project {
  id: string
  name: string
  framework: string
  board_fqbn: string
  created_at: string
  latest_build?: LatestBuild
}

export default function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showTarImport, setShowTarImport] = useState(false)

  const [form, setForm] = useState({
    name: '',
    framework: 'arduino',
    board_fqbn: 'esp32:esp32:esp32',
  })

  const [importForm, setImportForm] = useState({
    git_url: '',
    branch: '',
    sub_dir: '',
    name: '',
    framework: 'arduino',
    board_fqbn: 'esp32:esp32:esp32',
  })
  const [importError, setImportError] = useState<string | null>(null)

  const [tarFile, setTarFile] = useState<File | null>(null)
  const [tarForm, setTarForm] = useState({
    name: '',
    framework: 'auto',
    board_fqbn: 'esp32:esp32:esp32',
    custom_cmd: '',
  })
  const [tarImportError, setTarImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: projects = [], isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    refetchInterval: (query) => {
      const list = query.state.data as Project[] | undefined
      const hasRunning = list?.some(p => p.latest_build?.status === 'running' || p.latest_build?.status === 'pending')
      return hasRunning ? 3000 : false
    },
  })

  const { data: boards = [] } = useQuery<Board[]>({
    queryKey: ['boards'],
    queryFn: boardsApi.list,
  })

  const createMutation = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: (project: Project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
      navigate(`/editor/${project.id}`)
    },
  })

  const importMutation = useMutation({
    mutationFn: importApi.fromGit,
    onSuccess: (data: { project_id?: string; id?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowImport(false)
      const pid = data.project_id || data.id
      if (pid) {
        navigate(`/editor/${pid}`)
      }
    },
    onError: (err: any) => {
      const data = err.response?.data
      let msg = data?.error || data?.details || err.message || '导入失败，请检查仓库地址与网络连接'
      if (data?.details && data?.error && !data.error.includes(data.details)) {
        msg = `${data.error}: ${data.details}`
      }
      setImportError(msg)
    },
  })

  const tarImportMutation = useMutation({
    mutationFn: (formData: FormData) => importApi.fromArchive(formData),
    onSuccess: (data: { project_id?: string; id?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowTarImport(false)
      const pid = data.project_id || data.id
      if (pid) {
        navigate(`/editor/${pid}`)
      }
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error || err.message || '导入压缩包失败，请检查文件格式是否有效'
      setTarImportError(msg)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: projectsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (err: any) => {
      alert(`删除项目失败: ${err.response?.data?.error || err.message}`)
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    createMutation.mutate(form)
  }

  const handleImport = (e: React.FormEvent) => {
    e.preventDefault()
    setImportError(null)
    importMutation.mutate({
      git_url: importForm.git_url.trim(),
      branch: importForm.branch.trim() || undefined,
      sub_dir: importForm.sub_dir.trim() || undefined,
      name: importForm.name.trim() || undefined,
      framework: importForm.framework,
      board_fqbn: importForm.board_fqbn,
    })
  }

  const handleTarFileSelect = (file: File) => {
    setTarFile(file)
    setTarImportError(null)
    if (!tarForm.name) {
      let base = file.name
      for (const ext of ['.tar.gz', '.tgz', '.tar', '.zip']) {
        if (base.toLowerCase().endsWith(ext)) {
          base = base.slice(0, base.length - ext.length)
          break
        }
      }
      setTarForm(prev => ({ ...prev, name: base }))
    }
  }

  const handleTarImport = (e: React.FormEvent) => {
    e.preventDefault()
    if (!tarFile) {
      setTarImportError('请先选择或拖拽项目压缩包文件')
      return
    }
    setTarImportError(null)
    const formData = new FormData()
    formData.append('file', tarFile)
    if (tarForm.name.trim()) formData.append('name', tarForm.name.trim())
    if (tarForm.framework) formData.append('framework', tarForm.framework)
    if (tarForm.board_fqbn) formData.append('board_fqbn', tarForm.board_fqbn)
    if (tarForm.custom_cmd.trim()) formData.append('custom_cmd', tarForm.custom_cmd.trim())

    tarImportMutation.mutate(formData)
  }

  return (
    <div className="min-h-screen bg-dark-900 text-gray-100">
      {/* Header */}
      <header className="border-b border-dark-600 bg-dark-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Cpu className="text-blue-400" size={24} />
          <h1 className="text-xl font-bold tracking-tight">ESP32 Web IDE</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setTarImportError(null)
              setTarFile(null)
              setShowTarImport(true)
            }}
            className="flex items-center gap-2 bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-500 px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <UploadCloud size={16} />
            导入 Tar 压缩包
          </button>
          <button
            onClick={() => {
              setImportError(null)
              setShowImport(true)
            }}
            className="flex items-center gap-2 bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-500 px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <GitBranch size={16} />
            从 Git 导入
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            新建项目
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <h2 className="text-lg font-semibold text-gray-300 mb-4">我的项目</h2>

        {loadingProjects ? (
          <div className="flex items-center gap-2 text-gray-500 py-12 justify-center">
            <Loader2 size={20} className="animate-spin" />
            <span>加载中...</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <Folder size={48} className="mx-auto mb-4 opacity-30" />
            <p className="text-lg">还没有项目</p>
            <p className="text-sm mt-1">点击右上角「新建项目」或「从 Git 导入」开始</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => (
              <div
                key={p.id}
                onClick={() => navigate(`/editor/${p.id}`)}
                className="flex items-center justify-between bg-dark-800 hover:bg-dark-700/80 border border-dark-600 rounded-lg px-5 py-4 text-left transition-colors group cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-100 group-hover:text-white truncate">{p.name}</span>
                    {p.latest_build && (
                      p.latest_build.status === 'running' || p.latest_build.status === 'pending' ? (
                        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse shrink-0">
                          <Loader2 size={11} className="animate-spin" />
                          后台编译中...
                        </span>
                      ) : p.latest_build.status === 'success' ? (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/20 text-green-400 border border-green-500/30 shrink-0">
                          <CheckCircle2 size={11} />
                          编译就绪
                        </span>
                      ) : p.latest_build.status === 'cancelled' ? (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
                          <Square size={10} className="fill-current" />
                          已中止
                        </span>
                      ) : p.latest_build.status === 'failed' || p.latest_build.status === 'timeout' ? (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/20 text-red-400 border border-red-500/30 shrink-0">
                          <XCircle size={11} />
                          编译未通过
                        </span>
                      ) : null
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 truncate">
                    {p.framework.toUpperCase()} · {p.board_fqbn}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0 ml-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`确定要删除项目「${p.name}」吗？\n该项目的所有源码文件及编译记录都将被永久删除，不可恢复。`)) {
                        deleteMutation.mutate(p.id)
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    title="删除项目"
                    className="opacity-0 group-hover:opacity-100 p-2 text-gray-400 hover:text-red-400 hover:bg-red-950/40 rounded-md transition-all"
                  >
                    <Trash2 size={16} />
                  </button>
                  <ChevronRight size={18} className="text-gray-600 group-hover:text-gray-400 transition-colors" />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Create Project Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-5">新建项目</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">项目名称</label>
                <input
                  type="text"
                  required
                  placeholder="my-esp32-project"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">框架</label>
                <select
                  value={form.framework}
                  onChange={e => setForm(f => ({ ...f, framework: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="arduino">Arduino</option>
                  <option value="espidf">ESP-IDF</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">目标板型</label>
                <select
                  value={form.board_fqbn}
                  onChange={e => setForm(f => ({ ...f, board_fqbn: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                >
                  {(boards.length > 0 ? boards : [
                    { fqbn: 'esp32:esp32:esp32', name: 'ESP32 DevKitC' },
                    { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 DevKit' },
                    { fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi', name: 'ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)' },
                    { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3' },
                    { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32-S2' },
                    { fqbn: 'waveshare:esp32s3:touch_amoled_175c', name: 'Waveshare ESP32-S3-Touch-AMOLED-1.75C' },
                  ]).map(b => {
                    const fqbn = b.fqbn || b.id || ''
                    return (
                      <option key={fqbn} value={fqbn}>{b.name}</option>
                    )
                  })}
                </select>
              </div>

              {createMutation.isError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 rounded-md px-3 py-2">
                  <AlertCircle size={14} />
                  <span>创建失败，请重试</span>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 bg-dark-700 hover:bg-dark-600 text-gray-300 py-2 rounded-md text-sm transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import from Git Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center gap-2 mb-5">
              <GitBranch className="text-blue-400" size={20} />
              <h3 className="text-lg font-semibold">从 Git 仓库导入</h3>
            </div>
            <form onSubmit={handleImport} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Git 仓库地址 <span className="text-red-400">*</span>
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://github.com/user/repo.git"
                  value={importForm.git_url}
                  onChange={e => setImportForm(f => ({ ...f, git_url: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">分支（选填）</label>
                  <input
                    type="text"
                    placeholder="main"
                    value={importForm.branch}
                    onChange={e => setImportForm(f => ({ ...f, branch: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">子目录（选填）</label>
                  <input
                    type="text"
                    placeholder="e.g. platforms/esp32"
                    value={importForm.sub_dir}
                    onChange={e => setImportForm(f => ({ ...f, sub_dir: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">项目名称（选填，默认由仓库推断）</label>
                <input
                  type="text"
                  placeholder="留空则自动从 URL 解析"
                  value={importForm.name}
                  onChange={e => setImportForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">开发框架</label>
                  <select
                    value={importForm.framework}
                    onChange={e => setImportForm(f => ({ ...f, framework: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  >
                    <option value="arduino">Arduino</option>
                    <option value="espidf">ESP-IDF</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1">目标板型</label>
                  <select
                    value={importForm.board_fqbn}
                    onChange={e => setImportForm(f => ({ ...f, board_fqbn: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  >
                    {(boards.length > 0 ? boards : [
                      { fqbn: 'esp32:esp32:esp32', name: 'ESP32 DevKitC' },
                      { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 DevKit' },
                      { fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi', name: 'ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)' },
                      { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3' },
                      { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32-S2' },
                      { fqbn: 'waveshare:esp32s3:touch_amoled_175c', name: 'Waveshare ESP32-S3-Touch-AMOLED-1.75C' },
                    ]).map(b => {
                      const fqbn = b.fqbn || b.id || ''
                      return (
                        <option key={fqbn} value={fqbn}>{b.name}</option>
                      )
                    })}
                  </select>
                </div>
              </div>

              {importMutation.isError && (
                <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 border border-red-800/40 rounded-md px-3 py-2 max-h-48 overflow-y-auto">
                  <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
                  <span className="break-all whitespace-pre-wrap font-mono">{importError || '导入失败，请重试'}</span>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowImport(false)}
                  className="flex-1 bg-dark-700 hover:bg-dark-600 text-gray-300 py-2 rounded-md text-sm transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={importMutation.isPending}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {importMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  {importMutation.isPending ? '正在克隆与导入...' : '开始导入'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import from Tar/Zip Archive Modal */}
      {showTarImport && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-2 mb-5">
              <UploadCloud className="text-blue-400" size={22} />
              <div>
                <h3 className="text-lg font-semibold">导入项目压缩包</h3>
                <p className="text-xs text-gray-400 mt-0.5">支持 .tar, .tar.gz, .tgz, .zip 格式源码包，自动解压并保留完整目录树</p>
              </div>
            </div>

            <form onSubmit={handleTarImport} className="space-y-4">
              {/* 文件上传拖拽区 */}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5 font-medium">
                  项目压缩包文件 <span className="text-red-400">*</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".tar,.tar.gz,.tgz,.zip"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) handleTarFileSelect(f)
                  }}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const f = e.dataTransfer.files?.[0]
                    if (f) handleTarFileSelect(f)
                  }}
                  className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${
                    tarFile
                      ? 'border-blue-500/80 bg-blue-950/20'
                      : 'border-dark-500 hover:border-dark-400 bg-dark-900/50'
                  }`}
                >
                  {tarFile ? (
                    <div className="flex items-center justify-center gap-3 text-left">
                      <FileArchive className="text-blue-400 shrink-0" size={28} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-200 truncate">{tarFile.name}</div>
                        <div className="text-xs text-gray-400">
                          {(tarFile.size / 1024 / 1024).toFixed(2)} MB · 点击可更换文件
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <UploadCloud className="mx-auto text-gray-400" size={32} />
                      <div className="text-sm text-gray-300">
                        点击选择或将压缩包拖拽至此
                      </div>
                      <div className="text-xs text-gray-500">
                        支持 .tar, .tar.gz, .tgz, .zip（单个二进制资源最大支持 50MB）
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 项目名称 */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  项目名称 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="项目英文名称，如 moto-gps-waveshare"
                  value={tarForm.name}
                  onChange={e => setTarForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* 框架与板型 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">开发框架</label>
                  <select
                    value={tarForm.framework}
                    onChange={e => setTarForm(f => ({ ...f, framework: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  >
                    <option value="auto">自动识别 (推荐)</option>
                    <option value="arduino">Arduino</option>
                    <option value="espidf">ESP-IDF</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1">目标板型</label>
                  <select
                    value={tarForm.board_fqbn}
                    onChange={e => setTarForm(f => ({ ...f, board_fqbn: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  >
                    {(boards.length > 0 ? boards : [
                      { fqbn: 'esp32:esp32:esp32', name: 'ESP32 DevKitC' },
                      { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 DevKit' },
                      { fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi', name: 'ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)' },
                      { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3' },
                      { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32-S2' },
                      { fqbn: 'waveshare:esp32s3:touch_amoled_175c', name: 'Waveshare ESP32-S3-Touch-AMOLED-1.75C' },
                    ]).map(b => {
                      const fqbn = b.fqbn || b.id || ''
                      return (
                        <option key={fqbn} value={fqbn}>{b.name}</option>
                      )
                    })}
                  </select>
                </div>
              </div>

              {/* 可选自定义编译命令 */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  自定义编译命令（选填）
                </label>
                <input
                  type="text"
                  placeholder="留空使用默认编译，例如: idf.py build"
                  value={tarForm.custom_cmd}
                  onChange={e => setTarForm(f => ({ ...f, custom_cmd: e.target.value }))}
                  className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono text-xs"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  若项目包含特殊构建参数或子目录，可在项目创建后随时在编辑器面板调整
                </p>
              </div>

              {tarImportError && (
                <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-md px-3 py-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span className="break-all">{tarImportError}</span>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTarImport(false)}
                  disabled={tarImportMutation.isPending}
                  className="flex-1 bg-dark-700 hover:bg-dark-600 text-gray-300 py-2 rounded-md text-sm transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={tarImportMutation.isPending || !tarFile}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {tarImportMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  {tarImportMutation.isPending ? '正在解压并创建项目...' : '开始导入'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
