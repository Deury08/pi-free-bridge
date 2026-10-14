// repro.mjs — tripwire for OpenCode's anonymous free-tier gate.
//
// Run: node repro.mjs            (bun repro.mjs also works)
//      node repro.mjs <model-id> probe one specific model
//
// Expected: "200 SSE-CHUNK (PASS)"
//
// A 403 here means the vendor moved or hardened the gate again: re-measure it
// (capture a real Pi request through a local forwarder, then bisect) and update
// HANDOFF.md §4 before touching index.ts.
//
// Contract re-measured 2026-10-14 (see HANDOFF.md §4.2/§4.3):
//   headers: content-type, a user-agent containing "opencode/", any bearer
//            authorization, and x-opencode-session + x-opencode-session-id with a
//            server-valid session id. Header count is NOT part of the gate.
//   body:    stream:true, a leading system/developer message, and a non-empty
//            tools array containing BOTH "read" and "bash".
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID = "ses_eca394440ffeYFPjS30HnZEVBo"; // known-good; see README
const USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

// Pi's own tool definitions, so the tool names match what a real session sends.
const CAPTURE = process.env.PI_FREE_BRIDGE_CAPTURE; // optional: path to a captured Pi request body
function loadTools() {
  const fallback = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file from the filesystem",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];
  if (!CAPTURE || !readFileSync) return fallback;
  try {
    const captured = JSON.parse(readFileSync(CAPTURE, "utf8"));
    const tools = (captured.tools ?? []).filter((t) =>
      ["read", "bash"].includes(t?.function?.name),
    );
    return tools.length === 2 ? tools : fallback;
  } catch {
    return fallback;
  }
}

const headers = {
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  authorization: "Bearer public",
  "x-opencode-session": SESSION_ID,
  "x-opencode-session-id": SESSION_ID,
};

const body = {
  model: process.argv[2] ?? "mimo-v2.6-flash-free",
  stream: true,
  max_tokens: 16,
  messages: [
    { role: "system", content: "You are a helpful coding assistant." },
    { role: "user", content: "Reply with exactly: OK" },
  ],
  tools: loadTools(),
};

const r = await fetch("https://opencode.ai/inference/v1/chat/completions", {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

const txt = await r.text();
console.log(
  body.model,
  r.status,
  /chat\.completion\.chunk/.test(txt) ? "SSE-CHUNK (PASS)" : txt.slice(0, 300),
);