import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useEditorStore } from '../state/document-store.ts'
import { Viewport } from '../components/viewport/Viewport.tsx'
import { Sidebar } from '../components/Sidebar.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { StatusBar } from '../components/StatusBar.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'

export const Route = createFileRoute('/')({
  // the editor is fully client-side (WebGPU, workers, OPFS)
  ssr: false,
  component: Editor,
})

function Editor() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  // load saved document from OPFS + kick off the first regeneration
  useEffect(() => {
    void useEditorStore.getState().bootstrap()
  }, [])

  return (
    <div className="flex h-dvh w-dvw overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />

      <main className="relative min-w-0 flex-1">
        <Viewport />

        {/* floating chrome over the viewport */}
        <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
          <div className="pointer-events-auto">
            <TopBar onOpenSettings={() => setSettingsOpen(true)} />
          </div>
          <div className="mt-3 flex justify-center">
            <div className="pointer-events-auto">
              <Toolbar />
            </div>
          </div>
          <div className="flex-1" />
          <div className="pointer-events-auto">
            <StatusBar />
          </div>
        </div>

        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </main>
    </div>
  )
}
