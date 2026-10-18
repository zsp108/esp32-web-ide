import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// 注入 session token（MVP 无账户系统，用本地 UUID 标识用户）
apiClient.interceptors.request.use((config) => {
  let token = localStorage.getItem('session_token')
  if (!token) {
    token = crypto.randomUUID()
    localStorage.setItem('session_token', token)
  }
  config.headers['X-Session-Token'] = token
  return config
})

// --- 接口封装 ---
export const boardsApi = {
  list: () => apiClient.get('/boards').then(r => r.data),
}

export const projectsApi = {
  create: (data: { name: string; framework: string; board_fqbn: string }) =>
    apiClient.post('/projects', data).then(r => r.data),
  get: (id: string) => apiClient.get(`/projects/${id}`).then(r => r.data),
  list: () => apiClient.get('/projects').then(r => r.data),
  delete: (id: string) => apiClient.delete(`/projects/${id}`).then(r => r.data),
}

export const filesApi = {
  upload: (projectId: string, filePath: string, content: string) => {
    const form = new FormData()
    const blob = new Blob([content], { type: 'text/plain' })
    form.append('file', blob, filePath)
    form.append('path', filePath)
    return apiClient.put(`/projects/${projectId}/files`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  getContent: (projectId: string, filePath: string) =>
    apiClient.get(`/projects/${projectId}/files/${filePath}`).then(r => r.data),
  list: (projectId: string) =>
    apiClient.get(`/projects/${projectId}/files`).then(r => r.data),
  delete: (projectId: string, filePath: string) =>
    apiClient.delete(`/projects/${projectId}/files/${filePath}`).then(r => r.data),
  rename: (projectId: string, oldPath: string, newPath: string) =>
    apiClient.post(`/projects/${projectId}/files/rename`, { old_path: oldPath, new_path: newPath }).then(r => r.data),
}

export const buildsApi = {
  create: (data: { project_id: string; framework?: string; board?: string; board_fqbn?: string; custom_cmd?: string }) =>
    apiClient.post('/builds', data).then(r => r.data),
  get: (id: string) => apiClient.get(`/builds/${id}`).then(r => r.data),
  listByProject: (projectId: string) => apiClient.get(`/projects/${projectId}/builds`).then(r => r.data),
  downloadUrl: (id: string) => `/api/v1/builds/${id}/download`,
  cancel: (id: string) => apiClient.post(`/builds/${id}/cancel`).then(r => r.data),
}

export const importApi = {
  fromGit: (data: {
    git_url: string;
    branch?: string;
    name?: string;
    framework: string;
    board_fqbn: string;
    sub_dir?: string;
  }) => apiClient.post('/import/git', data).then(r => r.data),
  fromArchive: (formData: FormData) =>
    apiClient.post('/projects/import-tar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
}
