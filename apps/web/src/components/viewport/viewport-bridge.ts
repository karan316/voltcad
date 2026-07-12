import type { SceneManager } from "./scene-manager.ts";

/**
 * Bridge for components outside the Viewport tree (view cube, future
 * section tools) that need the live SceneManager without prop drilling.
 */
export const viewportBridge: { manager: SceneManager | null } = { manager: null };
