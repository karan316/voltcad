import { z } from "zod";
import { RegenError, defineFeature } from "@voltcad/model-api";

/**
 * Import feature: embeds a STEP/IGES file in the history. Deterministic —
 * the same payload always produces the same bodies with the same names, so
 * downstream features (fillets on imported edges) stay valid.
 *
 * The file text lives in the feature params. Fine for typical part files
 * (<10MB); a content-addressed blob store is the planned optimization when
 * P2P sync lands.
 */
export const importFeature = defineFeature({
  type: "import",
  label: "Import",
  schema: z.object({
    format: z.enum(["step", "iges"]).describe("CAD exchange format of the payload"),
    data: z.string().min(1).describe("Raw file contents (ISO-10303-21 / IGES text)"),
  }),
  regenerate(ctx, params, featureId) {
    if (params.format === "step" && !params.data.trimStart().startsWith("ISO-10303-21"))
      throw new RegenError("INVALID_PARAMS", "Payload is not a STEP (ISO-10303-21) file");
    ctx.importShape(featureId, params.format, params.data);
  },
});
