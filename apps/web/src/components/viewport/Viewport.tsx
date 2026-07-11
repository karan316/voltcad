import { useEffect, useRef } from "react";
import { useEditorStore } from "../../state/document-store.ts";
import { useThemeStore } from "../../state/theme-store.ts";
import { SceneManager } from "./scene-manager.ts";

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
        const hit = manager.pick(x, y);
        const store = useEditorStore.getState();
        if (hit) store.select(hit, e.shiftKey);
        else store.clearSelection();
      }}
      onPointerLeave={() => useEditorStore.getState().setHovered(null)}
    />
  );
}
