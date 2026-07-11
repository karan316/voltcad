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
  };
}
