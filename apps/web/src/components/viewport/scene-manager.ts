import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";
import type { BodyMesh, PlaneBasis, SceneUpdate } from "@voltcad/model-api";
import { toUV } from "@voltcad/model-api";
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
    background: 0xedeff4,
    body: 0xdfe2ea,
    edge: 0x363c52,
    sketch: 0x2b50e8,
    hover: 0x2b50e8,
    selected: 0xe8590c,
    grid: 0xd7dae3,
    gridCenter: 0xc5c9d6,
    hemiSky: 0xffffff,
    hemiGround: 0x848aa0,
  },
  dark: {
    background: 0x0d1020,
    body: 0x9aa6cc,
    edge: 0x181d33,
    sketch: 0x7d97ff,
    hover: 0x7d97ff,
    selected: 0xffa94d,
    grid: 0x191e36,
    gridCenter: 0x272e4e,
    hemiSky: 0xdfe4f5,
    hemiGround: 0x171b30,
  },
} as const;

export type ViewportTheme = keyof typeof THEMES;

interface BodyView {
  data: BodyMesh;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  /** Geometric center, used to compute exploded-view offsets. */
  center: THREE.Vector3;
  /** Current explode displacement (world units). */
  offset: THREE.Vector3;
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
  private draftGroup = new THREE.Group();
  private bodies: BodyView[] = [];
  private explodeFactor = 0;
  private dirty = true;
  private disposed = false;
  private theme: ViewportTheme = "dark";
  private grid: THREE.GridHelper | null = null;
  private hemi!: THREE.HemisphereLight;
  private sketchPlane: THREE.Plane | null = null;
  private sketchBasis: PlaneBasis | null = null;
  /** Camera pose saved on sketch entry, restored on exit. */
  private savedCamera: { pos: THREE.Vector3; target: THREE.Vector3 } | null =
    null;
  /** Fired after each rendered frame with the camera quaternion (view cube). */
  onCameraChange: ((q: THREE.Quaternion) => void) | null = null;

  private draftMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.selected,
  });
  private previewMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.hover,
    transparent: true,
    opacity: 0.7,
  });
  private cursorMaterial = new THREE.PointsMaterial({
    color: THEMES.dark.selected,
    size: 8,
    sizeAttenuation: false,
  });

  private bodyMaterial = new THREE.MeshStandardMaterial({
    color: THEMES.dark.body,
    metalness: 0.05,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  private edgeMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.edge,
  });
  private sketchMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.sketch,
  });
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
  private hoverEdgeMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.hover,
    linewidth: 2,
  });
  private selectedEdgeMaterial = new THREE.LineBasicMaterial({
    color: THEMES.dark.selected,
    linewidth: 2,
  });

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
    this.scene.add(
      this.modelGroup,
      this.sketchGroup,
      this.highlightGroup,
      this.draftGroup,
    );

    this.raycaster.params.Line.threshold = 0.8;

    this.setTheme(this.theme); // applies clear color, grid, materials
    this.resize();
    this.loop();
  }

  /** Re-color the viewport for light/dark UI theme. Cheap: no geometry work. */
  setTheme(theme: ViewportTheme): void {
    this.theme = theme;
    const t = THEMES[theme];
    this.draftMaterial.color.setHex(t.selected);
    this.previewMaterial.color.setHex(t.hover);
    this.cursorMaterial.color.setHex(t.selected);
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
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(body.positions, 3),
      );
      geo.setAttribute("normal", new THREE.BufferAttribute(body.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(body.indices, 1));
      const mesh = new THREE.Mesh(geo, this.bodyMaterial);

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(body.edgePositions, 3),
      );
      const edges = new THREE.LineSegments(edgeGeo, this.edgeMaterial);

      geo.computeBoundingBox();
      const center = geo.boundingBox!.getCenter(new THREE.Vector3());
      this.modelGroup.add(mesh, edges);
      this.bodies.push({
        data: body,
        mesh,
        edges,
        center,
        offset: new THREE.Vector3(),
      });
    }
    this.applyExplode(); // keep exploded state across regenerations

    for (const sketch of update.sketches) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(sketch.positions, 3),
      );
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
   * Exploded view — pure display transform, the document is untouched.
   * Each body slides radially away from the assembly centroid, proportional
   * to its distance from it (Onshape-style), so relative arrangement reads
   * clearly. factor 0 = assembled, 1 = fully exploded.
   */
  setExplode(factor: number): void {
    this.explodeFactor = factor;
    this.applyExplode();
    this.dirty = true;
  }

  private applyExplode(): void {
    if (this.bodies.length === 0) return;
    const centroid = new THREE.Vector3();
    for (const b of this.bodies) centroid.add(b.center);
    centroid.divideScalar(this.bodies.length);

    // model size gives a floor for the push distance, so bodies whose centers
    // sit near the centroid (e.g. a pin inside a plate) still separate
    const box = new THREE.Box3();
    for (const b of this.bodies) box.expandByObject(b.mesh);
    const size = box.getSize(new THREE.Vector3()).length() || 1;

    this.bodies.forEach((b, i) => {
      const dir = b.center.clone().sub(centroid);
      if (dir.lengthSq() < 1e-6) {
        // coincident with centroid — spread deterministically by index
        dir.set(
          Math.cos((i * 2 * Math.PI) / this.bodies.length),
          Math.sin((i * 2 * Math.PI) / this.bodies.length),
          0.5,
        );
      }
      // proportional push + minimum separation floor
      b.offset
        .copy(dir)
        .multiplyScalar(this.explodeFactor * 1.6)
        .addScaledVector(dir.normalize(), this.explodeFactor * size * 0.12);
      b.mesh.position.copy(b.offset);
      b.edges.position.copy(b.offset);
    });
  }

  /**
   * Pick the entity under the pointer. Edges win over faces when both are hit
   * within a small depth tolerance (they're always coincident with a face).
   */
  pick(ndcX: number, ndcY: number): Selection | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    // magnetic edges: keep the hit radius constant in SCREEN space (~6px)
    // regardless of zoom — fixed world-space thresholds feel wrong on
    // trackpads (too grabby zoomed out, impossible zoomed in)
    this.raycaster.params.Line.threshold = this.worldPerPixel() * 6;

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

    // prefer the edge if it's essentially at the surface we hit (~4px depth)
    if (
      bestEdge &&
      (!bestFace || bestEdge.dist <= bestFace.dist + this.worldPerPixel() * 4)
    )
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
      for (const { data, offset } of this.bodies) {
        if (sel.kind === "face") {
          const group = data.faceGroups.find((g) => g.name === sel.name);
          if (!group) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.BufferAttribute(data.positions, 3),
          );
          geo.setAttribute(
            "normal",
            new THREE.BufferAttribute(data.normals, 3),
          );
          // zero-copy: index view into the body's index buffer
          geo.setIndex(
            new THREE.BufferAttribute(
              data.indices.subarray(group.start, group.start + group.count),
              1,
            ),
          );
          const overlay = new THREE.Mesh(
            geo,
            isHover ? this.hoverFaceMaterial : this.selectedFaceMaterial,
          );
          overlay.position.copy(offset); // follow the body in exploded view
          this.highlightGroup.add(overlay);
        } else if (sel.kind === "edge") {
          const edge = data.edges.find((e) => e.name === sel.name);
          if (!edge) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.BufferAttribute(data.edgePositions, 3),
          );
          geo.setDrawRange(edge.start, edge.count);
          const overlay = new THREE.LineSegments(
            geo,
            isHover ? this.hoverEdgeMaterial : this.selectedEdgeMaterial,
          );
          overlay.position.copy(offset);
          this.highlightGroup.add(overlay);
        }
      }
    };

    for (const sel of selection) add(sel, false);
    if (hovered && !selection.some((s) => s.name === hovered.name))
      add(hovered, true);
    this.dirty = true;
  }

  // ------------------------------------------------------------- sketch mode

  /**
   * Enter sketch mode: fly the camera to look squarely at the plane and lock
   * rotation (pan/zoom stay live — 2D drafting camera).
   */
  enterSketchMode(basis: PlaneBasis): void {
    // remember where the user was so finishing the sketch isn't disorienting
    if (!this.savedCamera) {
      this.savedCamera = {
        pos: this.controls.getPosition(new THREE.Vector3()),
        target: this.controls.getTarget(new THREE.Vector3()),
      };
    }
    this.sketchBasis = basis;
    this.sketchPlane = new THREE.Plane(
      new THREE.Vector3(...basis.normal),
      -new THREE.Vector3(...basis.normal).dot(
        new THREE.Vector3(...basis.origin),
      ),
    );
    const dist = Math.max(this.controls.distance, 120);
    const target = new THREE.Vector3(...basis.origin);
    const eye = target
      .clone()
      .addScaledVector(new THREE.Vector3(...basis.normal), dist);
    // up = plane's V axis so the sketch grid reads upright
    this.camera.up.set(...basis.v);
    void this.controls.setLookAt(
      eye.x,
      eye.y,
      eye.z,
      target.x,
      target.y,
      target.z,
      true,
    );
    this.controls.mouseButtons.left = CameraControls.ACTION.NONE;
    this.sketchGroup.visible = false; // draft overlay replaces saved wireframes
    this.dirty = true;
  }

  exitSketchMode(): void {
    this.sketchBasis = null;
    this.sketchPlane = null;
    this.camera.up.set(0, 0, 1);
    this.controls.mouseButtons.left = CameraControls.ACTION.ROTATE;
    this.sketchGroup.visible = true;
    this.setSketchDraft(null, null, null);
    // fly back to the pre-sketch viewpoint
    if (this.savedCamera) {
      const { pos, target } = this.savedCamera;
      this.savedCamera = null;
      void this.controls.setLookAt(
        pos.x,
        pos.y,
        pos.z,
        target.x,
        target.y,
        target.z,
        true,
      );
    }
    this.dirty = true;
  }

  /** Standard isometric view, framed on the model. */
  homeView(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    const sphere = box.isEmpty()
      ? new THREE.Sphere(new THREE.Vector3(0, 0, 0), 80)
      : box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(1, -1, 0.8).normalize();
    const dist =
      (sphere.radius * 1.6) / Math.tan((this.camera.fov * Math.PI) / 360);
    const eye = sphere.center.clone().addScaledVector(dir, dist);
    void this.controls.setLookAt(
      eye.x,
      eye.y,
      eye.z,
      sphere.center.x,
      sphere.center.y,
      sphere.center.z,
      true,
    );
    this.dirty = true;
  }

  /** Snap the camera to a named direction, keeping target and distance. */
  snapToView(
    dir: [number, number, number],
    up: [number, number, number],
  ): void {
    const target = this.controls.getTarget(new THREE.Vector3());
    const dist = this.controls.distance;
    const eye = target
      .clone()
      .addScaledVector(new THREE.Vector3(...dir).normalize(), dist);
    this.camera.up.set(...up);
    void this.controls.setLookAt(
      eye.x,
      eye.y,
      eye.z,
      target.x,
      target.y,
      target.z,
      true,
    );
    this.dirty = true;
  }

  /**
   * Capture the viewport as a JPEG data URL (AI "eyes": lets the copilot
   * inspect what it built). Renders synchronously first — the drawing buffer
   * is only valid immediately after a render.
   */
  captureImage(maxSize = 768): string {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(src.width * scale);
    canvas.height = Math.round(src.height * scale);
    canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  /** Pointer NDC → snapped-to-plane UV coordinates (mm). Null if parallel. */
  raycastSketchPlane(ndcX: number, ndcY: number): [number, number] | null {
    if (!this.sketchPlane || !this.sketchBasis) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.sketchPlane, hit)) return null;
    return toUV(this.sketchBasis, [hit.x, hit.y, hit.z]);
  }

  /** World-units per CSS pixel at the camera target (for snap radii). */
  worldPerPixel(): number {
    const h = this.container.clientHeight || 1;
    return (
      (2 *
        this.controls.distance *
        Math.tan((this.camera.fov * Math.PI) / 360)) /
      h
    );
  }

  /** Update the draft overlay: committed soup, live preview soup, cursor. */
  setSketchDraft(
    draft: Float32Array | null,
    preview: Float32Array | null,
    cursor: [number, number, number] | null,
  ): void {
    for (const child of [...this.draftGroup.children])
      (child as THREE.Mesh).geometry.dispose();
    this.draftGroup.clear();

    const addLines = (
      soup: Float32Array,
      material: THREE.LineBasicMaterial,
    ) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(soup, 3));
      this.draftGroup.add(new THREE.LineSegments(geo, material));
    };
    if (draft && draft.length > 0) addLines(draft, this.draftMaterial);
    if (preview && preview.length > 0) addLines(preview, this.previewMaterial);
    if (cursor) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(cursor), 3),
      );
      this.draftGroup.add(new THREE.Points(geo, this.cursorMaterial));
    }
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
      this.onCameraChange?.(this.camera.quaternion);
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
    if (vertexIndex >= e.start && vertexIndex < e.start + e.count)
      return e.name;
  }
  return null;
}
