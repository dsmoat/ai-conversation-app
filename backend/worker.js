const MAX_ROUNDS = 3;
const MAX_TOPIC_LENGTH = 500;
const MAX_MODEL_MESSAGES = 8;
const MAX_TOKENS = 1000;
const MIN_WORDS = 10;
const AI_ERROR_MESSAGE = "The AI service could not complete the conversation.";

// Cloudflare's Workers AI catalog changes over time. Review this manually maintained
// allowlist occasionally against the official Workers AI model catalog and remove any
// model that becomes deprecated or loses streamed chat-message support.
const SUPPORTED_MODELS = [
  { id: "@cf/meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct" },
  { id: "@cf/meta/llama-3.2-3b-instruct", name: "Llama 3.2 3B Instruct" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B Instruct Fast" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", name: "Mistral Small 3.1 24B Instruct" },
  { id: "@cf/google/gemma-3-12b-it", name: "Gemma 3 12B Instruct" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen2.5 Coder 32B Instruct" }
];
const DEFAULT_AGENT_A_MODEL = SUPPORTED_MODELS[0].id;
const DEFAULT_AGENT_B_MODEL = SUPPORTED_MODELS[1].id;

const RESPONSE_LENGTH_INSTRUCTION = "Produce a response of approximately 20 to 1,000 tokens. Even when there is little to add, provide at least one substantive sentence rather than an empty or one-word response. Never exceed the configured maximum output length.";
const AGENT_A_SYSTEM_PROMPT = `You are Agent A, a thoughtful advocate who opens with constructive arguments and responds directly to Agent B. ${RESPONSE_LENGTH_INSTRUCTION}`;
const AGENT_B_SYSTEM_PROMPT = `You are Agent B, a thoughtful skeptic who challenges assumptions while staying respectful and specific. ${RESPONSE_LENGTH_INSTRUCTION}`;

function getAllowedOrigin(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigin = env.ALLOWED_ORIGIN || "*";
  if (configuredOrigin === "*") return requestOrigin || "*";
  return requestOrigin === configuredOrigin ? requestOrigin : null;
}
function corsHeaders(request, env, contentType = "application/json; charset=utf-8") {
  const origin = getAllowedOrigin(request, env);
  if (!origin) return null;
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin", ...(contentType ? { "Content-Type": contentType } : {}) };
}
function jsonResponse(request, env, body, status = 200) {
  const headers = corsHeaders(request, env);
  if (!headers) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json; charset=utf-8", "Vary": "Origin" } });
  return new Response(JSON.stringify(body), { status, headers });
}
function sseEncode(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
async function writeEvent(writer, encoder, event, data) { await writer.write(encoder.encode(sseEncode(event, data))); }
function validateModel(id) { return typeof id === "string" ? SUPPORTED_MODELS.find((model) => model.id === id) : null; }
function buildMessages(systemPrompt, topic, transcript, retryTooShort) {
  const recent = transcript.slice(-MAX_MODEL_MESSAGES).map((item) => ({ role: item.agent === "A" ? "assistant" : "user", content: `Agent ${item.agent}, round ${item.round}: ${item.content}` }));
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Debate topic: ${topic}` },
    ...recent,
    { role: "user", content: retryTooShort ? "Your previous response was too short. Give one concise but substantive explanation." : "Continue the debate from your assigned role." }
  ];
}
function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.response === "string") return payload.response;
  if (typeof payload.result?.response === "string") return payload.result.response;
  if (typeof payload.output_text === "string") return payload.output_text;
  const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text;
  return typeof delta === "string" ? delta : "";
}
async function readWorkersAIStream(aiResponse, onText) {
  const stream = aiResponse?.body ? aiResponse.body : aiResponse;
  if (!stream?.getReader) throw new Error("AI_STREAM_UNAVAILABLE");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = "";
  async function processEvent(raw) {
    const dataLines = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return;
    const text = extractText(JSON.parse(data));
    if (text) { complete += text; await onText(text); }
  }
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) await processEvent(part);
    if (done) break;
  }
  if (buffer.trim()) await processEvent(buffer);
  return complete;
}
function isUsable(text) { return text.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS; }
async function streamAgentResponse({ env, model, systemPrompt, topic, transcript, agent, round, writer, encoder, retryTooShort = false }) {
  await writeEvent(writer, encoder, "status", { message: `Agent ${agent} is thinking...` });
  await writeEvent(writer, encoder, "message_start", { agent, round, model });
  const aiResponse = await env.AI.run(model, { messages: buildMessages(systemPrompt, topic, transcript, retryTooShort), max_tokens: MAX_TOKENS, stream: true });
  const content = await readWorkersAIStream(aiResponse, (text) => writeEvent(writer, encoder, "token", { agent, round, content: text }));
  const trimmed = content.trim();
  if (!trimmed) throw new Error("AI_EMPTY_RESPONSE");
  if (!isUsable(trimmed) && !retryTooShort) {
    await writeEvent(writer, encoder, "message_end", { agent, round });
    return streamAgentResponse({ env, model, systemPrompt, topic, transcript, agent, round, writer, encoder, retryTooShort: true });
  }
  if (!isUsable(trimmed)) throw new Error("AI_TOO_SHORT");
  await writeEvent(writer, encoder, "message_end", { agent, round });
  transcript.push({ agent, round, content: trimmed });
  return trimmed;
}
async function handleDebate(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse(request, env, { error: "Invalid JSON" }, 400); }
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const rounds = Number(body.rounds);
  const agentAModel = validateModel(body.agentAModel)?.id;
  const agentBModel = validateModel(body.agentBModel)?.id;
  if (!topic || topic.length > MAX_TOPIC_LENGTH || !Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) return jsonResponse(request, env, { error: "Invalid topic or rounds" }, 400);
  if (!agentAModel || !agentBModel) return jsonResponse(request, env, { error: "Unsupported model selection" }, 400);
  const headers = corsHeaders(request, env, "text/event-stream; charset=utf-8");
  if (!headers) return jsonResponse(request, env, { error: "Origin not allowed" }, 403);
  headers["Cache-Control"] = "no-cache";
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    const transcript = [];
    try {
      for (let round = 1; round <= rounds; round += 1) {
        await streamAgentResponse({ env, model: agentAModel, systemPrompt: AGENT_A_SYSTEM_PROMPT, topic, transcript, agent: "A", round, writer, encoder });
        await streamAgentResponse({ env, model: agentBModel, systemPrompt: AGENT_B_SYSTEM_PROMPT, topic, transcript, agent: "B", round, writer, encoder });
      }
      await writeEvent(writer, encoder, "done", { message: "Conversation completed" });
    } catch (_) { await writeEvent(writer, encoder, "error", { message: AI_ERROR_MESSAGE }); }
    finally { await writer.close(); }
  })();
  return new Response(readable, { headers });
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env, null) || { "Vary": "Origin" } });
  if (url.pathname === "/health") return request.method === "GET" ? jsonResponse(request, env, { ok: true }) : jsonResponse(request, env, { error: "Method not allowed" }, 405);
  if (url.pathname === "/models") return request.method === "GET" ? jsonResponse(request, env, { models: SUPPORTED_MODELS, defaults: { agentA: DEFAULT_AGENT_A_MODEL, agentB: DEFAULT_AGENT_B_MODEL } }) : jsonResponse(request, env, { error: "Method not allowed" }, 405);
  if (url.pathname === "/debate") return request.method === "POST" ? handleDebate(request, env) : jsonResponse(request, env, { error: "Method not allowed" }, 405);
  return jsonResponse(request, env, { error: "Not found" }, 404);
} };
export { SUPPORTED_MODELS, readWorkersAIStream, handleDebate };
