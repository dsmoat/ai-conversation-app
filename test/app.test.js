import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { SUPPORTED_MODELS } from "../backend/worker.js";

const env = {
  ALLOWED_ORIGIN: "https://example.com",
  AI: {
    calls: [],
    async run(model, payload) {
      this.calls.push({ model, payload });
      const response = "This streamed response deliberately contains more than ten words so it is considered usable by the safeguard.";
      return new Response(`data: {"response":"${response}"}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
  }
};
function req(path, init = {}) { return new Request(`https://worker.test${path}`, { headers: { Origin: "https://example.com", ...(init.headers || {}) }, ...init }); }

test("model selectors load from backend models and no duplicate frontend allowlist exists", async () => {
  const html = await readFile("index.html", "utf8");
  const js = await readFile("script.js", "utf8");
  assert.match(html, /id="agent-a-model"/);
  assert.match(html, /id="agent-b-model"/);
  assert.match(js, /\/models/);
  assert.doesNotMatch(js, /SUPPORTED_MODELS/);
});

test("both agents can use the same allowed model", async () => {
  env.AI.calls = [];
  const model = SUPPORTED_MODELS[0].id;
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Same model", rounds: 1, agentAModel: model, agentBModel: model }) }), env);
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(env.AI.calls.map((call) => call.model), [model, model]);
});

test("both agents can use different allowed models sequentially", async () => {
  env.AI.calls = [];
  const a = SUPPORTED_MODELS[0].id;
  const b = SUPPORTED_MODELS[1].id;
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Different models", rounds: 1, agentAModel: a, agentBModel: b }) }), env);
  const text = await response.text();
  assert.ok(text.indexOf('"agent":"A"') < text.indexOf('"agent":"B"'));
  assert.deepEqual(env.AI.calls.map((call) => call.model), [a, b]);
});

test("arbitrary model IDs are rejected", async () => {
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Reject", rounds: 1, agentAModel: "@cf/not/real", agentBModel: SUPPORTED_MODELS[0].id }) }), env);
  assert.equal(response.status, 400);
});

test("deprecated or non-chat models are not shown", () => {
  const ids = SUPPORTED_MODELS.map((model) => model.id).join("\n");
  assert.doesNotMatch(ids, /deprecated|embedding|embed|stable-diffusion|whisper|tts|translation|sentiment|classification/i);
  assert.ok(SUPPORTED_MODELS.every((model) => model.id.startsWith("@cf/")));
});

test("streaming output appears incrementally and Agent B starts after Agent A finishes", async () => {
  let call = 0;
  const orderedEnv = { ...env, AI: { calls: [], async run() { call += 1; const body = call === 1 ? 'data: {"response":"Agent A first partial "}\n\ndata: {"response":"and final substantive words here."}\n\ndata: [DONE]\n\n' : 'data: {"response":"Agent B starts only after Agent A has completed sufficiently."}\n\ndata: [DONE]\n\n'; return new Response(body); } } };
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Order", rounds: 1, agentAModel: SUPPORTED_MODELS[0].id, agentBModel: SUPPORTED_MODELS[1].id }) }), orderedEnv);
  const text = await response.text();
  assert.ok(text.includes("Agent A first partial"));
  assert.ok(text.indexOf('event: message_end\ndata: {"agent":"A"') < text.indexOf('event: message_start\ndata: {"agent":"B"'));
});

test("status changes for every agent and round", async () => {
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Statuses", rounds: 2, agentAModel: SUPPORTED_MODELS[0].id, agentBModel: SUPPORTED_MODELS[1].id }) }), env);
  const text = await response.text();
  assert.equal((text.match(/event: status/g) || []).length, 4);
});

test("partial output remains visible after streaming failure", async () => {
  const failingEnv = { ...env, AI: { async run() { return new Response('data: {"response":"Partial output remains visible before failure occurs here."}\n\ndata: {bad json}\n\n'); } } };
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Failure", rounds: 1, agentAModel: SUPPORTED_MODELS[0].id, agentBModel: SUPPORTED_MODELS[1].id }) }), failingEnv);
  const text = await response.text();
  assert.ok(text.includes("Partial output remains visible"));
  assert.ok(text.includes("event: error"));
});

test("Start button and selectors restoration logic exists", async () => {
  const js = await readFile("script.js", "utf8");
  assert.match(js, /finally\s*{[\s\S]*setRunning\(false\)/);
  assert.match(js, /agentAModelSelect\.disabled = nextRunning/);
  assert.match(js, /agentBModelSelect\.disabled = nextRunning/);
});

test("responses can exceed old 200-token limit and never request more than 1000 tokens", async () => {
  env.AI.calls = [];
  const response = await worker.fetch(req("/debate", { method: "POST", body: JSON.stringify({ topic: "Long", rounds: 1, agentAModel: SUPPORTED_MODELS[0].id, agentBModel: SUPPORTED_MODELS[1].id }) }), env);
  await response.text();
  assert.ok(env.AI.calls.every((call) => call.payload.max_tokens === 1000));
});

test("/models rejects unapproved browser origins", async () => {
  const response = await worker.fetch(new Request("https://worker.test/models", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(response.status, 403);
});

test("model output is never rendered through innerHTML", async () => {
  const js = await readFile("script.js", "utf8");
  assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /createTextNode\(content\)/);
});
