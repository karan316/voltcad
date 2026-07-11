import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";
import type { BodyMesh, SceneUpdate } from "@voltcad/model-api";
import type { Selection } from "../../state/document-store.ts";

CameraControls.install({ THREE });

/**
 * SceneManager — imperative Three.js layer for the CAD viewport.
 *
 * Performance principles:
 *  - WebGPU renderer with automatic WebGL2 fallback (three r185 handles this).
 *  - On-demand rendering: frames are drawn only when the camera moves or the
 *    scene/highlights change — a static model costs ~0 CPU/GPU.
 *  - Mesh buffers arrive as transferred typed arrays and are handed straight
 *    to BufferAttributes (no copies). Highlights reuse the same buffers via
 *    index subarrays / drawRange — zero geometry duplication.
 *  - All body edges render as ONE LineSegments draw call per body.
 */

const THEMES = {
  light: {
    background: 0xe8e6e1,
    body: 0xe3e0d8,
    edge: 0x3a3d42,
    sketch: 0x2f6fdb,
    hover: 0x3b82f6,
    selected: 0xe8590c,
    grid: 0xd2cfc8,
    gridCenter: 0xc2bfb8,
    hemiSky: 0xffffff,
    hemiGround: 0x8a8a80,
  },
  dark: {
    background: 0x101318,
    body: 0x9fb2c8,
    edge: 0x1c2733,
    sketch: 0x4f8ff7,
    hover: 0x63b3ff,
    selected: 0xffa94d,
    grid: 0x1a222c,
    gridCenter: 0x2a3340,
    hemiSky: 0xdfe8f5,
    hemiGround: 0x1a2027,
  },
} as const;

export type ViewportTheme = keyof typeof THEMES;

interface BodyView {
  data: BodyMesh;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
}

export class SceneManager {
  private renderer!: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls!: CameraControls;
  private raycaster = new THREE.Raycaster();
  private timer = new THREE.Timer();

  private modelGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private highlightGroup = new THREE.Group();
  private bodies: BodyView[] = [];
  private dirty = true;
  private disposed = false;
  private theme: ViewportTheme = "dark";
  private grid: THREE.GridHelper | null = null;
  private hemi!: THREE.HemisphereLight;

  private bodyMaterial = new THREE.MeshStandardMaterial({
    color: THEMES.dark.body,
    metalness: 0.05,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  private edgeMaterial = new THREE.LineBasicMaterial({ color: THEMES.dark.edge });
  private sketchMaterial = new THREE.LineBasicMaterial({ color: THEMES.dark.sketch });
  private hoverFaceMaterial = new THREE.MeshBasicMaterial({
    color: THEMES.dark.hover,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  });
  private selectedFaceMaterial = new THREE.MeshBasicMaterial({
    color: THEMES.dark.selected,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  });
  private hoverEdgeMaterial = new THREE.LineBasicMaterial({ color: THEMES.dark.hover, linewidth: 2 });
  private selectedEdgeMaterial = new THREE.LineBasicMaterial({ color: THEMES.dark.selected, linewidth: 2 });

  constructor(private container: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50_000);
    this.camera.up.set(0, 0, 1); // CAD convention: Z up
    this.camera.position.set(120, -120, 90);
  }

  async init(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init(); // picks WebGPU, falls back to WebGL2
    // guard: React StrictMode mounts/unmounts effects twice — if we were
    // disposed while awaiting the async renderer init, don't touch the DOM
    if (this.disposed) {
      renderer.dispose();
      return;
    }
    this.renderer = renderer;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new CameraControls(this.camera, this.renderer.domElement);
    this.controls.dollyToCursor = true;
    this.controls.draggingSmoothTime = 0.05;
    this.controls.smoothTime = 0.12;
    this.controls.mouseButtons.right = CameraControls.ACTION.TRUCK;

    // lighting tuned for neutral machined-part look
    this.hemi = new THREE.HemisphereLight(0xdfe8f5, 0x1a2027, 1.1);
    this.scene.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(200, -150, 300);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    fill.position.set(-150, 200, -100);
    this.scene.add(fill);

    this.scene.add(new THREE.AxesHelper(30));
    this.scene.add(this.modelGroup, this.sketchGroup, this.highlightGroup);

    this.raycaster.params.Line.threshold = 0.8;

    this.setTheme(this.theme); // applies clear color, grid, materials
    this.resize();
    this.loop();
  }

  /** Re-color the viewport for light/dark UI theme. Cheap: no geometry work. */
  setTheme(theme: ViewportTheme): void {
    this.theme = theme;
    const t = THEMES[theme];
    this.renderer?.setClearColor(t.background);
    this.bodyMaterial.color.setHex(t.body);
    this.edgeMaterial.color.setHex(t.edge);
    this.sketchMaterial.color.setHex(t.sketch);
    this.hoverFaceMaterial.color.setHex(t.hover);
    this.hoverEdgeMaterial.color.setHex(t.hover);
    this.selectedFaceMaterial.color.setHex(t.selected);
    this.selectedEdgeMaterial.color.setHex(t.selected);
    if (this.hemi) {
      this.hemi.color.setHex(t.hemiSky);
      this.hemi.groundColor.setHex(t.hemiGround);
    }
    // GridHelper colors are baked into vertex colors — rebuild it
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.scene.remove(this.grid);
    }
    this.grid = new THREE.GridHelper(500, 50, t.gridCenter, t.grid);
    this.grid.rotation.x = Math.PI / 2; // XY plane
    this.scene.add(this.grid);
    this.dirty = true;
  }

  /** Swap in a freshly regenerated scene. Old GPU buffers are freed. */
  applyScene(update: SceneUpdate): void {
    for (const view of this.bodies) {
      view.mesh.geometry.dispose();
      view.edges.geometry.dispose();
    }
    this.modelGroup.clear();
    this.sketchGroup.clear();
    this.bodies = [];

    for (const body of update.bodies) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(body.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(body.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(body.indices, 1));
      const mesh = new THREE.Mesh(geo, this.bodyMaterial);

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute("position", new THREE.BufferAttribute(body.edgePositions, 3));
      const edges = new THREE.LineSegments(edgeGeo, this.edgeMaterial);

      this.modelGroup.add(mesh, edges);
      this.bodies.push({ data: body, mesh, edges });
    }

    for (const sketch of update.sketches) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(sketch.positions, 3));
      this.sketchGroup.add(new THREE.LineSegments(geo, this.sketchMaterial));
    }
    this.dirty = true;
  }

  /** Frame the model (called once after first geometry arrives). */
  fitToModel(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) return;
    // fitToSphere preserves the current (isometric) view direction;
    // fitToBox would snap the camera to the nearest axis
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius *= 1.25;
    void this.controls.fitToSphere(sphere, true);
    this.dirty = true;
  }

  /**
   * Pick the entity under the pointer. Edges win over faces when both are hit
   * within a small depth tolerance (they're always coincident with a face).
   */
  pick(ndcX: number, ndcY: number): Selection | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    let bestFace: { name: string; dist: number } | null = null;
    let bestEdge: { name: string; dist: number } | null = null;

    for (const { data, mesh, edges } of this.bodies) {
      for (const hit of this.raycaster.intersectObject(mesh, false)) {
        if (hit.faceIndex === undefined || hit.faceIndex === null) continue;
        const group = findFaceGroup(data, hit.faceIndex * 3);
        if (group && (!bestFace || hit.distance < bestFace.dist))
          bestFace = { name: group, dist: hit.distance };
        break; // nearest hit per mesh is enough
      }
      for (const hit of this.raycaster.intersectObject(edges, false)) {
        if (hit.index === undefined) continue;
        const name = findEdge(data, hit.index);
        if (name && (!bestEdge || hit.distance < bestEdge.dist))
          bestEdge = { name, dist: hit.distance };
        break;
      }
    }

    // prefer the edge if it's essentially at the surface we hit
    if (bestEdge && (!bestFace || bestEdge.dist <= bestFace.dist + 1.5))
      return { name: bestEdge.name, kind: "edge" };
    if (bestFace) return { name: bestFace.name, kind: "face" };
    return null;
  }

  /** Rebuild highlight overlays (cheap: shares GPU buffers with the model). */
  setHighlights(hovered: Selection | null, selection: Selection[]): void {
    for (const child of [...this.highlightGroup.children]) {
      // geometries here share buffers with body meshes — dispose only the
      // index/drawRange wrapper geometry, not the underlying attributes
      (child as THREE.Mesh).geometry.dispose();
    }
    this.highlightGroup.clear();

    const add = (sel: Selection, isHover: boolean) => {
      for (const { data } of this.bodies) {
        if (sel.kind === "face") {
          const group = data.faceGroups.find((g) => g.name === sel.name);
          if (!group) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
          // zero-copy: index view into the body's index buffer
          geo.setIndex(
            new THREE.BufferAttribute(data.indices.subarray(group.start, group.start + group.count), 1),
          );
          this.highlightGroup.add(
            new THREE.Mesh(geo, isHover ? this.hoverFaceMaterial : this.selectedFaceMaterial),
          );
        } else if (sel.kind === "edge") {
          const edge = data.edges.find((e) => e.name === sel.name);
          if (!edge) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(data.edgePositions, 3));
          geo.setDrawRange(edge.start, edge.count);
          this.highlightGroup.add(
            new THREE.LineSegments(geo, isHover ? this.hoverEdgeMaterial : this.selectedEdgeMaterial),
          );
        }
      }
    };

    for (const sel of selection) add(sel, false);
    if (hovered && !selection.some((s) => s.name === hovered.name)) add(hovered, true);
    this.dirty = true;
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h);
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    this.timer.update();
    const updated = this.controls.update(this.timer.getDelta());
    if (updated || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  dispose(): void {
    this.disposed = true;
    this.controls?.dispose();
    for (const view of this.bodies) {
      view.mesh.geometry.dispose();
      view.edges.geometry.dispose();
    }
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}

/** Map a hit index-buffer offset to its B-Rep face via binary search. */
function findFaceGroup(body: BodyMesh, indexOffset: number): string | null {
  const groups = body.faceGroups;
  let lo = 0;
  let hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = groups[mid]!;
    if (indexOffset < g.start) hi = mid - 1;
    else if (indexOffset >= g.start + g.count) lo = mid + 1;
    else return g.name;
  }
  return null;
}

/** Map a line-segment vertex index to its B-Rep edge. */
function findEdge(body: BodyMesh, vertexIndex: number): string | null {
  for (const e of body.edges) {
    if (vertexIndex >= e.start && vertexIndex < e.start + e.count) return e.name;
  }
  return null;
}
