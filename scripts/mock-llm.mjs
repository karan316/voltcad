/**
 * Mock OpenAI-compatible chat completions server for E2E-testing the copilot
 * without a real LLM. Scripted behavior:
 *   - request WITHOUT tool results → streams a tool call that builds a part
 *   - request WITH tool results    → streams a short text summary
 * Run: node scripts/mock-llm.mjs  (listens on :8787)
 */
import { createServer } from "node:http";

const PORT = 8787;

const TOOL_CALL_ARGS = JSON.stringify({
  features: [
    {
      type: "sketch",
      id: "sk_puck",
      name: "Puck Sketch",
      plane: { kind: "datum", plane: "XY" },
      entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 20 }],
    },
    { type: "extrude", name: "Puck", sketch: "sk_puck", distance: 8, op: "new" },
  ],
});

function sseChunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "mock-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404, cors);
    return res.end();
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body);
    const hasToolResults = payload.messages.some((m) => m.role === "tool");
    res.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    if (!hasToolResults) {
      res.write(sseChunk({ role: "assistant", content: "" }));
      res.write(sseChunk({ content: "Building a puck: circle sketch + extrude. " }));
      res.write(
        sseChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: "add_features", arguments: "" },
            },
          ],
        }),
      );
      // stream the arguments in two slices to exercise incremental parsing
      const args = TOOL_CALL_ARGS;
      const mid = Math.floor(args.length / 2);
      res.write(
        sseChunk({
          tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }],
        }),
      );
      res.write(
        sseChunk({
          tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }],
        }),
      );
      res.write(sseChunk({}, "tool_calls"));
    } else {
      // check what actually happened and summarize like a good copilot
      const toolMsg = payload.messages.filter((m) => m.role === "tool").pop();
      const ok = /\bok\b/.test(JSON.stringify(toolMsg?.content ?? "")) &&
        !/"status":\s*\\*"error/.test(JSON.stringify(toolMsg?.content ?? ""));
      res.write(sseChunk({ role: "assistant", content: "" }));
      res.write(
        sseChunk({
          content: ok
            ? "Done — built a ø40×8mm puck (circle sketch on XY, extruded 8mm)."
            : "The build reported errors; check the feature statuses.",
        }),
      );
      res.write(sseChunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, () => console.log(`mock LLM on http://localhost:${PORT}/v1`));
