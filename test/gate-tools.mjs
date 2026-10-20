// Test for the free-tier gate's `tools` requirement (HANDOFF §4.2).
//
// Run: node test/gate-tools.mjs
//
// The gate rejects any request whose `tools` array does not carry both `read` and
// `bash`. Pi's one-off calls — auto-compaction, `/compact` and branch
// summarization — build their context with a prompt and no tools
// (dist/core/compaction/compaction.js, buildSummarizationContext), so they
// answered `403 FreeTierError`. The bridge injects the two names and pins
// `toolChoice` to `none` so the summary call cannot invoke them.
//
// The tool replay below mirrors Pi's `getCurrentTools` (pi-ai utils/transcript.js):
// every system message contributes `toolsAdded`/`toolsRemoved` deltas in order.
// It is replicated here because the package stays dependency-free outside Pi —
// `@earendil-works/pi-ai` is supplied by the host, not resolvable from this folder.
import assert from "node:assert/strict";

const { gateRequestContext } = await import("../index.ts");
assert.equal(
	typeof gateRequestContext,
	"function",
	"gateRequestContext must be exported",
);

const GATE_TOOLS = ["read", "bash"];

// --- local replay of Pi's tool resolution -----------------------------------

function resolveTools(messages) {
	const tools = new Map();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

function hasGateTools(messages) {
	const names = new Set(resolveTools(messages).map((tool) => tool.name));
	return GATE_TOOLS.every((name) => names.has(name));
}

const tool = (name) => ({ name, description: name, parameters: { type: "object" } });

// --- cases -------------------------------------------------------------------

// 1. The reported bug: Pi's compaction context is a prompt plus one user message.
{
	const messages = [
		{ role: "system", content: "You summarize conversations.", timestamp: 0 },
		{ role: "user", content: [{ type: "text", text: "<conversation>…</conversation>" }], timestamp: 1 },
	];
	const result = gateRequestContext({ messages });
	assert.deepEqual(
		result.messages.map((m) => m.role),
		["system", "user", "system"],
		"the injection must not rewrite the existing transcript",
	);
	assert.equal(result.toolChoice, "none", "a tools-less call must not be able to invoke them");
	assert.ok(hasGateTools(result.messages), "read and bash must resolve after injection");
	assert.equal(
		result.messages[0].content,
		"You summarize conversations.",
		"the summarization prompt must survive untouched",
	);
	assert.deepEqual(
		result.messages[1].content,
		[{ type: "text", text: "<conversation>…</conversation>" }],
		"the user message must survive untouched",
	);
}

// 2. No system message at all: the injection still lands somewhere resolvable.
{
	const messages = [{ role: "user", content: "hi", timestamp: 0 }];
	const result = gateRequestContext({ messages });
	assert.ok(hasGateTools(result.messages), "read and bash must resolve after injection");
}

// 3. Already satisfied (the normal conversation path): nothing is added.
{
	const messages = [
		{ role: "system", content: "sys", toolsAdded: [tool("read"), tool("bash"), tool("edit")], timestamp: 0 },
		{ role: "user", content: "hi", timestamp: 1 },
	];
	const result = gateRequestContext({ messages });
	assert.deepEqual(result.messages, messages, "a satisfied context must be returned as-is");
	assert.equal(result.messages.length, 2, "no system message may be appended");
	assert.equal(result.toolChoice, undefined, "no toolChoice override when nothing was injected");
}

// 4. A partial tool set keeps what it has and gets only the missing names.
{
	const messages = [
		{ role: "system", content: "sys", toolsAdded: [tool("edit")], timestamp: 0 },
		{ role: "user", content: "hi", timestamp: 1 },
	];
	const result = gateRequestContext({ messages });
	const names = resolveTools(result.messages).map((t) => t.name).sort();
	assert.deepEqual(names, ["bash", "edit", "read"], "the injected set must be the union");
}

// 5. A removal earlier in the transcript must not silently drop the injected tool:
//    Pi resolves every delta, so the injection has to come after the removal.
{
	const messages = [
		{ role: "system", content: "sys", toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
		{ role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 2 },
	];
	const result = gateRequestContext({ messages });
	assert.ok(hasGateTools(result.messages), "read must be present again after the removal");
}

// 6. Idempotence: a second pass must not duplicate the tools.
{
	const messages = [{ role: "user", content: "hi", timestamp: 0 }];
	const once = gateRequestContext({ messages });
	const twice = gateRequestContext(once);
	const names = resolveTools(twice.messages).map((t) => t.name).sort();
	assert.deepEqual(names, ["bash", "read"], "no duplicates after a second pass");
}

console.log("OK — gate tools injected for tools-less requests");
