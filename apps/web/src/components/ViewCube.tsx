import { useEffect, useRef } from "react";
import { Matrix4, Quaternion } from "three";
import { viewportBridge } from "./viewport/viewport-bridge.ts";

/**
 * CSS-3D view cube: mirrors the camera orientation, clickable faces snap to
 * standard views. Model space is Z-up; CSS space is Y-down, so the rotation
 * matrix is conjugated by diag(1,-1,1) (negate every element with exactly one
 * Y index) before being handed to matrix3d().
 */

const SIZE = 58;
const HALF = SIZE / 2;

interface Face {
  label: string;
  /** CSS placement of the face on the cube. */
  css: string;
  /** Camera direction (from target) + up vector for the snapped view. */
  dir: [number, number, number];
  up: [number, number, number];
}

const FACES: Face[] = [
  { label: "FRONT",  css: `rotateX(-90deg) translateZ(${HALF}px)`, dir: [0, -1, 0], up: [0, 0, 1] },
  { label: "BACK",   css: `rotateX(90deg) translateZ(${HALF}px)`,  dir: [0, 1, 0],  up: [0, 0, 1] },
  { label: "RIGHT",  css: `rotateY(90deg) translateZ(${HALF}px)`,  dir: [1, 0, 0],  up: [0, 0, 1] },
  { label: "LEFT",   css: `rotateY(-90deg) translateZ(${HALF}px)`, dir: [-1, 0, 0], up: [0, 0, 1] },
  { label: "TOP",    css: `translateZ(${HALF}px)`,                 dir: [0, 0, 1],  up: [0, 1, 0] },
  { label: "BOTTOM", css: `rotateY(180deg) translateZ(${HALF}px)`, dir: [0, 0, -1], up: [0, -1, 0] },
];

export function ViewCube() {
  const cubeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = new Matrix4();
    const q = new Quaternion();
    let raf = 0;
    const attach = () => {
      const manager = viewportBridge.manager;
      if (!manager) {
        raf = requestAnimationFrame(attach);
        return;
      }
      manager.onCameraChange = (quat) => {
        const el = cubeRef.current;
        if (!el) return;
        q.copy(quat).invert();
        m.makeRotationFromQuaternion(q);
        const e = [...m.elements];
        // three (Y-up world semantics) → CSS (Y-down): flip xy cross terms
        e[1] = -e[1]!;
        e[4] = -e[4]!;
        e[6] = -e[6]!;
        e[9] = -e[9]!;
        el.style.transform = `matrix3d(${e.join(",")})`;
      };
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      if (viewportBridge.manager) viewportBridge.manager.onCameraChange = null;
    };
  }, []);

  return (
    <div
      className="pointer-events-auto select-none"
      style={{ width: SIZE + 26, height: SIZE + 26, perspective: "340px" }}
    >
      <div
        ref={cubeRef}
        className="relative mx-auto mt-[13px]"
        style={{ width: SIZE, height: SIZE, transformStyle: "preserve-3d" }}
      >
        {FACES.map((f) => (
          <button
            key={f.label}
            className="absolute inset-0 flex items-center justify-center font-mono text-[8px] font-semibold tracking-[0.08em] transition-colors"
            style={{
              transform: f.css,
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              color: "var(--text-muted)",
              backfaceVisibility: "hidden",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent-soft)";
              e.currentTarget.style.color = "var(--label)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--surface)";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
            onClick={() => viewportBridge.manager?.snapToView(f.dir, f.up)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
