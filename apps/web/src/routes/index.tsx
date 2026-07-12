import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useEditorStore } from '../state/document-store.ts'
import { useSketchStore } from '../state/sketch-store.ts'
import { Viewport } from '../components/viewport/Viewport.tsx'
import { Sidebar } from '../components/Sidebar.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { StatusBar } from '../components/StatusBar.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import { ViewportOverlays } from '../components/ViewportOverlays.tsx'

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

  // global shortcuts: sketch-mode keys first, then document undo/redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const sketch = useSketchStore.getState()
      if (sketch.active) {
        if (e.key === 'Escape') {
          e.preventDefault()
          sketch.escape()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          sketch.finish()
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          sketch.removeLast() // draft-level undo while sketching
        }
        return
      }

      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      const store = useEditorStore.getState()
      if (e.shiftKey) store.redo()
      else store.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-dvh w-dvw gap-3 overflow-hidden p-3" style={{ background: 'var(--bg)' }}>
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />

      <main className="relative min-w-0 flex-1 overflow-hidden rounded-xl" style={{ boxShadow: 'var(--shadow-panel)' }}>
        <Viewport />
        <ViewportOverlays />

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
