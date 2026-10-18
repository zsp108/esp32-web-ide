import { Routes, Route, Navigate } from 'react-router-dom'
import HomePage from './pages/Home'
import EditorPage from './pages/Editor'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/editor/:projectId" element={<EditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
