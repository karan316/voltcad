import { tool } from "ai";
import { z } from "zod";
import {
  entityQuerySchema,
  newFeatureId,
  sketchConstraintSchema,
  sketchEntitySchema,
  sketchPlaneSchema,
  type FeatureNode,
  type PartDocument,
} from "@voltcad/model-api";
import { regenSettled, useEditorStore } from "../../state/document-store.ts";
import { getGeometryWorker } from "@voltcad/geometry-worker";
import { viewportBridge } from "../../components/viewport/viewport-bridge.ts";

/**
 * AI tool set — the ONLY way the model touches the document.
 *
 * Every mutation goes through the exact same write path as manual edits
 * (replaceDocument → validate → regenerate), so AI actions are undoable,
 * autosaved, and can never corrupt geometry. Tool results always include
 * per-feature regeneration statuses so the model can self-correct
 * (e.g. FILLET_TOO_LARGE → retry with a smaller radius).
 */

const expr = z
  .union([z.string(), z.number()])
  .describe('Dimension expression in mm (angles in deg), e.g. 25 or "thickness * 2"');

const idField = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .optional()
  .describe("Optional id for this feature so later features in the SAME call can reference it (e.g. extrude.sketch)");

// Parameter schemas per feature type, mirrored from @voltcad/features-std.
// Kept explicit here so tool JSON schemas stay small and LLM-friendly.
const featureInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sketch"),
    id: idField,
    name: z.string().optional(),
    plane: sketchPlaneSchema,
    entities: z.array(sketchEntitySchema).min(1),
    constraints: z.array(sketchConstraintSchema).optional(),
  }),
  z.object({
    type: z.literal("extrude"),
    id: idField,
    name: z.string().optional(),
    sketch: z.string().describe("Feature id of the profile sketch"),
    distance: expr,
    symmetric: z.boolean().optional(),
    op: z.enum(["new", "add", "cut", "intersect"]).optional(),
  }),
  z.object({
    type: z.literal("revolve"),
    id: idField,
    name: z.string().optional(),
    sketch: z.string(),
    axisPoint: z.tuple([z.number(), z.number()]).optional(),
    axisDir: z.tuple([z.number(), z.number()]).optional(),
    angle: expr.optional(),
    op: z.enum(["new", "add", "cut", "intersect"]).optional(),
  }),
  z.object({
    type: z.literal("fillet"),
    id: idField,
    name: z.string().optional(),
    edges: entityQuerySchema.describe("Query selecting edges to round"),
    radius: expr,
  }),
  z.object({
    type: z.literal("chamfer"),
    id: idField,
    name: z.string().optional(),
    edges: entityQuerySchema.describe("Query selecting edges to bevel"),
    distance: expr,
  }),
  z.object({
    type: z.literal("shell"),
    id: idField,
    name: z.string().optional(),
    faces: entityQuerySchema.describe("Faces to remove (the openings)"),
    thickness: expr.describe("Wall thickness in mm"),
  }),
  z.object({
    type: z.literal("linear_pattern"),
    id: idField,
    name: z.string().optional(),
    bodies: entityQuerySchema.optional().describe("Bodies to pattern (default: all)"),
    direction: z.tuple([z.number(), z.number(), z.number()]).describe("World direction"),
    spacing: expr.describe("Distance between instances (mm)"),
    count: expr.describe("Total instances including original (≥2)"),
    merge: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("circular_pattern"),
    id: idField,
    name: z.string().optional(),
    bodies: entityQuerySchema.optional(),
    axisPoint: z.tuple([z.number(), z.number(), z.number()]).optional(),
    axisDir: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Default [0,0,1]"),
    count: expr,
    totalAngle: expr.optional().describe("Degrees, default 360"),
    merge: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("mirror"),
    id: idField,
    name: z.string().optional(),
    bodies: entityQuerySchema.optional(),
    plane: z.enum(["XY", "XZ", "YZ"]),
    offset: expr.optional().describe("Plane offset along its normal (mm)"),
    merge: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    id: idField,
    name: z.string().optional(),
    target: entityQuerySchema.describe("Target body (kept)"),
    tool: entityQuerySchema.describe("Tool body (consumed)"),
    op: z.enum(["union", "subtract", "intersect"]),
  }),
]);

/** Split tool input into a FeatureNode (params = everything but type/name). */
function toFeatureNode(
  input: z.infer<typeof featureInputSchema>,
  taken: Set<string>,
): FeatureNode {
  const { type, name, id, ...params } = input;
  const finalId = id && !taken.has(id) ? id : newFeatureId(type);
  taken.add(finalId);
  return {
    id: finalId as FeatureNode["id"],
    type,
    name: name ?? type.charAt(0).toUpperCase() + type.slice(1),
    params,
  };
}

/** Wait for regen and report what happened, entity names included. */
async function regenReport() {
  await regenSettled();
  const s = useEditorStore.getState();
  return {
    features: s.doc.features.map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      status: s.statuses[f.id]?.status ?? "unknown",
      error: s.statuses[f.id]?.error?.message,
    })),
    massProperties: s.massProps,
    entities: currentEntities(),
  };
}

/** Compact listing of all named entities for grounding fillet/chamfer edits. */
function currentEntities() {
  const scene = useEditorStore.getState().scene;
  if (!scene) return { faces: [], edges: [] };
  const faces: string[] = [];
  const edges: string[] = [];
  for (const b of scene.bodies) {
    for (const g of b.faceGroups) faces.push(g.name);
    for (const e of b.edges) edges.push(e.name);
  }
  return { faces, edges };
}

function commitDoc(doc: PartDocument): void {
  useEditorStore.getState().replaceDocument(doc);
}

export function createCadTools() {
  return {
    get_model_state: tool({
      description:
        "Read the current document: features with parameters and statuses, named parameters, all entity names (faces/edges), current selection, and mass properties. Call this before modifying anything.",
      inputSchema: z.object({}),
      execute: async () => {
        const s = useEditorStore.getState();
        return {
          document: s.doc,
          statuses: s.statuses,
          selection: s.selection,
          massProperties: s.massProps,
          entities: currentEntities(),
        };
      },
    }),

    add_features: tool({
      description:
        "Append features to the history. A sketch defines 2D profiles (closed loops become faces); extrude/revolve turn a sketch's profiles into solids; fillet/chamfer dress existing edges (select via entity-name queries). Returns regeneration results — check every feature's status.",
      inputSchema: z.object({ features: z.array(featureInputSchema).min(1) }),
      execute: async ({ features }) => {
        const s = useEditorStore.getState();
        const taken = new Set(s.doc.features.map((f) => f.id as string));
        const nodes = features.map((f) => toFeatureNode(f, taken));
        commitDoc({ ...s.doc, features: [...s.doc.features, ...nodes] });
        return { createdIds: nodes.map((n) => n.id), ...(await regenReport()) };
      },
    }),

    update_feature: tool({
      description:
        "Update an existing feature's parameters (shallow-merged into current params), name, or suppressed state.",
      inputSchema: z.object({
        id: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        name: z.string().optional(),
        suppressed: z.boolean().optional(),
      }),
      execute: async ({ id, params, name, suppressed }) => {
        const s = useEditorStore.getState();
        if (!s.doc.features.some((f) => f.id === id))
          return { error: `No feature with id "${id}"` };
        commitDoc({
          ...s.doc,
          features: s.doc.features.map((f) =>
            f.id === id
              ? {
                  ...f,
                  ...(name !== undefined && { name }),
                  ...(suppressed !== undefined && { suppressed }),
                  ...(params && { params: { ...(f.params as object), ...params } }),
                }
              : f,
          ),
        });
        return regenReport();
      },
    }),

    delete_feature: tool({
      description: "Delete a feature from the history. Downstream features may fail.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const s = useEditorStore.getState();
        if (!s.doc.features.some((f) => f.id === id))
          return { error: `No feature with id "${id}"` };
        commitDoc({ ...s.doc, features: s.doc.features.filter((f) => f.id !== id) });
        return regenReport();
      },
    }),

    set_parameter: tool({
      description:
        'Create or update a named document parameter (e.g. thickness = 12). Features can reference parameters in expressions like "thickness * 2".',
      inputSchema: z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        value: z.union([z.string(), z.number()]),
      }),
      execute: async ({ name, value }) => {
        const s = useEditorStore.getState();
        commitDoc({ ...s.doc, parameters: { ...s.doc.parameters, [name]: value } });
        return regenReport();
      },
    }),

    describe_bodies: tool({
      description:
        "Get a geometric summary of every body: bounding box (min/max, mm), volume, center of mass, face count. Use to verify sizes/positions after building.",
      inputSchema: z.object({}),
      execute: async () => {
        await regenSettled();
        return { bodies: await getGeometryWorker().describeBodies() };
      },
    }),

    measure_distance: tool({
      description:
        "Minimum distance in mm between two named entities (bodies, faces, or edges). Use for verifying spacing, wall thicknesses, clearances.",
      inputSchema: z.object({
        a: z.string().describe("First entity name"),
        b: z.string().describe("Second entity name"),
      }),
      execute: async ({ a, b }) => {
        await regenSettled();
        const distance = await getGeometryWorker().measureDistance(a, b);
        return distance === null
          ? { error: "One or both entities not found" }
          : { distance };
      },
    }),

    capture_viewport: tool({
      description:
        "Render the current 3D viewport and LOOK at it. Use after building geometry to visually verify shape/proportions, or when the user references what's on screen. Optionally snap to a standard view first.",
      inputSchema: z.object({
        view: z
          .enum(["current", "iso", "front", "top", "right"])
          .default("current")
          .describe("Camera angle for the capture"),
      }),
      execute: async ({ view }) => {
        await regenSettled();
        const manager = viewportBridge.manager;
        if (!manager) return { image: null as string | null, view, error: "Viewport not ready" };
        if (view === "iso") manager.homeView();
        else if (view === "front") manager.snapToView([0, -1, 0], [0, 0, 1]);
        else if (view === "top") manager.snapToView([0, 0, 1], [0, 1, 0]);
        else if (view === "right") manager.snapToView([1, 0, 0], [0, 0, 1]);
        // let the camera transition settle before grabbing the frame
        if (view !== "current") await new Promise((r) => setTimeout(r, 700));
        return { image: manager.captureImage() as string | null, view, error: null as string | null };
      },
      // send the actual pixels to the model, not a JSON blob of base64
      toModelOutput: ({ output }) => {
        if (!output.image)
          return { type: "error-text", value: output.error ?? "capture failed" };
        return {
          type: "content",
          value: [
            { type: "text", text: `Viewport capture (${output.view} view):` },
            {
              type: "file",
              data: { type: "data", data: output.image.split(",")[1]! },
              mediaType: "image/jpeg",
            },
          ],
        };
      },
    }),
  };
}
