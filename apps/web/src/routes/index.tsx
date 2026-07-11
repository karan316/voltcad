import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useEditorStore } from '../state/document-store.ts'
import { Viewport } from '../components/viewport/Viewport.tsx'
import { FeatureTree } from '../components/FeatureTree.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { Inspector } from '../components/Inspector.tsx'
import { StatusBar } from '../components/StatusBar.tsx'

export const Route = createFileRoute('/')({
  // the editor is fully client-side (WebGPU, workers, OPFS)
  ssr: false,
  component: Editor,
})

function Editor() {
  // load saved document from OPFS + kick off the first regeneration
  useEffect(() => {
    void useEditorStore.getState().bootstrap()
  }, [])

  return (
    <div className="relative h-dvh w-dvw overflow-hidden bg-[#0b0f14] text-slate-200">
      {/* 3D viewport fills everything; panels float above it */}
      <Viewport />

      <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-2">
        <div className="pointer-events-auto">
          <Toolbar />
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-between gap-2">
          <div className="pointer-events-auto max-h-full">
            <FeatureTree />
          </div>
          <div className="pointer-events-auto">
            <Inspector />
          </div>
        </div>
        <div className="pointer-events-auto">
          <StatusBar />
        </div>
      </div>
    </div>
  )
}
