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
import { DimensionInput } from '../components/DimensionInput.tsx'
import { ConstraintBar } from '../components/ConstraintBar.tsx'
import { ViewCube } from '../components/ViewCube.tsx'

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
    <div className="flex h-dvh w-dvw flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* docked header rail */}
      <div className="dock-panel z-20 border-b" style={{ borderColor: 'var(--border)' }}>
        <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* docked sidebar */}
        <div className="dock-panel z-10 border-r" style={{ borderColor: 'var(--border)' }}>
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        </div>

        {/* full-bleed viewport */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <Viewport />
          <ViewportOverlays />

          {/* floating instruments over the viewport */}
          <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
            <div className="flex justify-center">
              <div className="pointer-events-auto flex flex-col items-center">
                <Toolbar />
                <DimensionInput />
                <ConstraintBar />
              </div>
            </div>
            <div className="mt-1 flex justify-end">
              <ViewCube />
            </div>
            <div className="flex-1" />
          </div>

          {/* docked status strip */}
          <div
            className="dock-panel absolute inset-x-0 bottom-0 border-t"
            style={{ borderColor: 'var(--border)' }}
          >
            <StatusBar />
          </div>

          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </main>
      </div>
    </div>
  )
}
