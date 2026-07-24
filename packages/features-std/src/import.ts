import { z } from "zod";
import { RegenError, defineFeature } from "@voltcad/model-api";

/**
 * Import feature: brings a STEP/IGES file into the history. Deterministic —
 * the same payload always produces the same bodies with the same names, so
 * downstream features (fillets on imported edges) stay valid.
 *
 * The file text lives in a content-addressed blob store keyed by `blobHash`;
 * the app inflates it into `data` right before regeneration so the document
 * (and the CRDT that syncs it) stays small. Inline `data` without a hash is
 * still accepted for backwards compatibility with older documents.
 */
export const importFeature = defineFeature({
  type: "import",
  label: "Import",
  schema: z
    .object({
      format: z
        .enum(["step", "iges"])
        .describe("CAD exchange format of the payload"),
      data: z
        .string()
        .min(1)
        .optional()
        .describe("Raw file contents (ISO-10303-21 / IGES text)"),
      blobHash: z
        .string()
        .optional()
        .describe(
          "sha256 key of the payload in the content-addressed blob store",
        ),
    })
    .refine((p) => p.data || p.blobHash, {
      message: "Either data or blobHash is required",
    }),
  regenerate(ctx, params, featureId) {
    if (!params.data)
      throw new RegenError(
        "MISSING_BLOB",
        "Imported file content is unavailable (blob not found in local store)",
      );
    if (
      params.format === "step" &&
      !params.data.trimStart().startsWith("ISO-10303-21")
    )
      throw new RegenError(
        "INVALID_PARAMS",
        "Payload is not a STEP (ISO-10303-21) file",
      );
    ctx.importShape(featureId, params.format, params.data);
  },
});
