import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Cpu, Folder, ChevronRight, Loader2, AlertCircle, GitBranch } from 'lucide-react'
import { projectsApi, boardsApi, importApi } from '../api/client'

interface Board {
  id?: string
  fqbn?: string
  name: string
  framework?: string | string[]
  idf_target?: string
}

interface Project {
  id: string
  name: string
  framework: string
  board_fqbn: string
  created_at: string
}

export default function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)

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

  const { data: projects = [], isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
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
      const msg = err.response?.data?.details || err.response?.data?.error || '导入失败，请检查仓库地址与网络连接'
      setImportError(msg)
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
              <button
                key={p.id}
                onClick={() => navigate(`/editor/${p.id}`)}
                className="flex items-center justify-between bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded-lg px-5 py-4 text-left transition-colors group"
              >
                <div>
                  <div className="font-medium text-gray-100 group-hover:text-white">{p.name}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {p.framework.toUpperCase()} · {p.board_fqbn}
                  </div>
                </div>
                <ChevronRight size={18} className="text-gray-600 group-hover:text-gray-400" />
              </button>
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
                {boards.length > 0 ? (
                  <select
                    value={form.board_fqbn}
                    onChange={e => setForm(f => ({ ...f, board_fqbn: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  >
                    {boards.map(b => {
                      const fqbn = b.fqbn || b.id || ''
                      return (
                        <option key={fqbn} value={fqbn}>{b.name}</option>
                      )
                    })}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="esp32:esp32:esp32"
                    value={form.board_fqbn}
                    onChange={e => setForm(f => ({ ...f, board_fqbn: e.target.value }))}
                    className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                )}
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
                  {boards.length > 0 ? (
                    <select
                      value={importForm.board_fqbn}
                      onChange={e => setImportForm(f => ({ ...f, board_fqbn: e.target.value }))}
                      className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                    >
                      {boards.map(b => {
                        const fqbn = b.fqbn || b.id || ''
                        return (
                          <option key={fqbn} value={fqbn}>{b.name}</option>
                        )
                      })}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder="esp32:esp32:esp32"
                      value={importForm.board_fqbn}
                      onChange={e => setImportForm(f => ({ ...f, board_fqbn: e.target.value }))}
                      className="w-full bg-dark-900 border border-dark-500 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                  )}
                </div>
              </div>

              {importMutation.isError && (
                <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-md px-3 py-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span className="break-all">{importError || '导入失败，请重试'}</span>
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
    </div>
  )
}
