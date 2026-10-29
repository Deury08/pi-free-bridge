const sid = process.argv[2];
const body = await Bun.file("body.json").text();
const r = await fetch("https://opencode.ai/inference/v1/chat/completions", {
  method: "POST", body,
  headers: {
    "Accept": "text/event-stream", "Content-Type": "application/json",
    "Authorization": "Bearer public", "User-Agent": "opencode/latest/2.0.29/cli",
    "x-opencode-client": "cli", "x-opencode-project": "global",
    "x-opencode-session": sid, "x-opencode-session-id": sid,
    "x-session-affinity": sid, "X-Session-Id": sid,
  },
});
console.log(`BUN: HTTP ${r.status}`);
const t = await r.text();
console.log(t.slice(0, 500));
