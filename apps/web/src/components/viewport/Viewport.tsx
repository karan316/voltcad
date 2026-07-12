import { useEffect, useRef } from "react";
import { sampleSketchEntitiesFromBasis, type SketchEntity } from "@voltcad/model-api";
import { useEditorStore } from "../../state/document-store.ts";
import { useThemeStore } from "../../state/theme-store.ts";
import { useSketchStore } from "../../state/sketch-store.ts";
import { SceneManager } from "./scene-manager.ts";
import { viewportBridge } from "./viewport-bridge.ts";

/**
 * React shell around the imperative SceneManager.
 * React never touches Three.js objects directly — it only forwards store
 * changes (scene, highlights) and pointer events across the boundary.
 */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const fittedRef = useRef(false);

  // one-time init
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const manager = new SceneManager(el);
    managerRef.current = manager;
    viewportBridge.manager = manager;
    manager.setTheme(useThemeStore.getState().theme);
    let cancelled = false;

    void manager.init().then(() => {
      if (cancelled) return;
      // scene may already be present (regen finished before renderer init)
      const { scene } = useEditorStore.getState();
      if (scene) {
        manager.applyScene(scene);
        manager.fitToModel();
        fittedRef.current = true;
      }
    });

    const observer = new ResizeObserver(() => manager.resize());
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      manager.dispose();
      managerRef.current = null;
      if (viewportBridge.manager === manager) viewportBridge.manager = null;
    };
  }, []);

  // scene updates
  useEffect(
    () =>
      useEditorStore.subscribe((state, prev) => {
        const manager = managerRef.current;
        if (!manager) return;
        if (state.scene && state.sceneVersion !== prev.sceneVersion) {
          manager.applyScene(state.scene);
          if (!fittedRef.current && state.scene.bodies.length > 0) {
            manager.fitToModel();
            fittedRef.current = true;
          }
          manager.setHighlights(state.hovered, state.selection);
        }
        if (state.fitCounter !== prev.fitCounter) manager.fitToModel();
        if (state.homeCounter !== prev.homeCounter) manager.homeView();
        if (state.hovered !== prev.hovered || state.selection !== prev.selection) {
          manager.setHighlights(state.hovered, state.selection);
        }
      }),
    [],
  );

  // theme changes
  useEffect(
    () =>
      useThemeStore.subscribe((state) => {
        managerRef.current?.setTheme(state.theme);
      }),
    [],
  );

  // sketch mode: enter/exit + draft overlay rebuild
  useEffect(
    () =>
      useSketchStore.subscribe((s, prev) => {
        const manager = managerRef.current;
        if (!manager) return;
        if (s.active !== prev.active) {
          if (s.active) manager.enterSketchMode(s.basis);
          else manager.exitSketchMode();
        }
        if (!s.active || s.version === prev.version) return;
        if (s.basis !== prev.basis && s.active) manager.enterSketchMode(s.basis);

        // committed entities in draft color
        const draft = sampleSketchEntitiesFromBasis(s.basis, s.entities);
        // live preview from pending point → cursor
        let preview: Float32Array | null = null;
        if (s.pending && s.cursor) {
          const previewEntity: SketchEntity | null =
            s.tool === "line"
              ? { id: "_p", type: "line", start: s.pending, end: s.cursor }
              : s.tool === "rectangle"
                ? { id: "_p", type: "rectangle", corner1: s.pending, corner2: s.cursor }
                : s.tool === "circle"
                  ? {
                      id: "_p",
                      type: "circle",
                      center: s.pending,
                      radius: Math.max(
                        0.01,
                        Math.hypot(s.cursor[0] - s.pending[0], s.cursor[1] - s.pending[1]),
                      ),
                    }
                  : null;
          if (previewEntity) preview = sampleSketchEntitiesFromBasis(s.basis, [previewEntity]);
        }
        const cursor3 = s.cursor
          ? ([
              s.basis.origin[0] + s.basis.u[0] * s.cursor[0] + s.basis.v[0] * s.cursor[1],
              s.basis.origin[1] + s.basis.u[1] * s.cursor[0] + s.basis.v[1] * s.cursor[1],
              s.basis.origin[2] + s.basis.u[2] * s.cursor[0] + s.basis.v[2] * s.cursor[1],
            ] as [number, number, number])
          : null;
        manager.setSketchDraft(draft, preview, cursor3);
      }),
    [],
  );

  // pointer → pick. Hover work is throttled to one raycast per frame.
  const rafPending = useRef(false);
  const lastMove = useRef<{ x: number; y: number } | null>(null);
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const ndc = (e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onPointerMove={(e) => {
        lastMove.current = ndc(e);
        if (rafPending.current) return;
        rafPending.current = true;
        requestAnimationFrame(() => {
          rafPending.current = false;
          const manager = managerRef.current;
          if (!manager || !lastMove.current) return;
          const sketch = useSketchStore.getState();
          if (sketch.active) {
            const uv = manager.raycastSketchPlane(lastMove.current.x, lastMove.current.y);
            if (uv) sketch.hover(uv, manager.worldPerPixel() * 10);
            return;
          }
          useEditorStore
            .getState()
            .setHovered(manager.pick(lastMove.current.x, lastMove.current.y));
        });
      }}
      onPointerDown={(e) => {
        if (e.button === 0) downPos.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        // click-select only if the pointer didn't drag (that's camera orbit)
        if (e.button !== 0 || !downPos.current) return;
        const moved =
          Math.hypot(e.clientX - downPos.current.x, e.clientY - downPos.current.y) > 4;
        downPos.current = null;
        if (moved) return;
        const manager = managerRef.current;
        if (!manager) return;
        const { x, y } = ndc(e);
        const sketch = useSketchStore.getState();
        if (sketch.active) {
          const uv = manager.raycastSketchPlane(x, y);
          if (uv) sketch.click(uv, manager.worldPerPixel() * 10);
          return;
        }
        const hit = manager.pick(x, y);
        const store = useEditorStore.getState();
        if (hit) store.select(hit, e.shiftKey);
        else store.clearSelection();
      }}
      onPointerLeave={() => useEditorStore.getState().setHovered(null)}
    />
  );
}
