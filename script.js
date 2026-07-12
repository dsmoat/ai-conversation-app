const WORKER_URL = window.WORKER_URL || "http://localhost:8787";
const INACTIVITY_TIMEOUT_MS = 45000;

const form = document.querySelector("#debate-form");
const topicInput = document.querySelector("#topic");
const roundsInput = document.querySelector("#rounds");
const agentAModelSelect = document.querySelector("#agent-a-model");
const agentBModelSelect = document.querySelector("#agent-b-model");
const startButton = document.querySelector("#start-button");
const clearButton = document.querySelector("#clear-button");
const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const transcriptEl = document.querySelector("#transcript");

let approvedModelIds = new Set();
let modelNames = new Map();
let running = false;
let activeMessages = new Map();

function setStatus(message) { statusEl.textContent = message; }
function setError(message = "") { errorEl.textContent = message; }
function setRunning(nextRunning) {
  running = nextRunning;
  startButton.disabled = nextRunning || approvedModelIds.size === 0;
  agentAModelSelect.disabled = nextRunning || approvedModelIds.size === 0;
  agentBModelSelect.disabled = nextRunning || approvedModelIds.size === 0;
}
function shouldAutoScroll() {
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  return distance < 80;
}
function scrollIfAppropriate(wasNearBottom) {
  if (wasNearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
function appendOption(select, model) {
  const option = document.createElement("option");
  option.value = model.id;
  option.textContent = model.name;
  select.append(option);
}
async function loadModels() {
  setStatus("Loading available models...");
  setRunning(false);
  startButton.disabled = true;
  try {
    const response = await fetch(`${WORKER_URL}/models`, { method: "GET" });
    if (!response.ok) throw new Error("MODELS_REQUEST_FAILED");
    const data = await response.json();
    if (!Array.isArray(data.models) || data.models.length === 0) throw new Error("MODELS_EMPTY");
    agentAModelSelect.textContent = "";
    agentBModelSelect.textContent = "";
    approvedModelIds = new Set();
    modelNames = new Map();
    for (const model of data.models) {
      if (!model || typeof model.id !== "string" || typeof model.name !== "string") continue;
      approvedModelIds.add(model.id);
      modelNames.set(model.id, model.name);
      appendOption(agentAModelSelect, model);
      appendOption(agentBModelSelect, model);
    }
    if (approvedModelIds.size === 0) throw new Error("NO_VALID_MODELS");
    if (approvedModelIds.has(data.defaults?.agentA)) agentAModelSelect.value = data.defaults.agentA;
    if (approvedModelIds.has(data.defaults?.agentB)) agentBModelSelect.value = data.defaults.agentB;
    setStatus("Ready");
    setRunning(false);
  } catch (_) {
    approvedModelIds = new Set();
    setStatus("The available Cloudflare models could not be loaded. Check the Worker URL and deployment.");
    startButton.disabled = true;
    agentAModelSelect.disabled = true;
    agentBModelSelect.disabled = true;
  }
}
function validateSelectedModels() {
  return approvedModelIds.has(agentAModelSelect.value) && approvedModelIds.has(agentBModelSelect.value);
}
function createMessageCard({ agent, round, model }) {
  const wasNearBottom = shouldAutoScroll();
  const card = document.createElement("article");
  card.className = `message-card agent-${agent.toLowerCase()}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const title = document.createElement("strong");
  title.textContent = `Agent ${agent} · Round ${round}`;
  const modelLabel = document.createElement("span");
  modelLabel.textContent = modelNames.get(model) || model;
  meta.append(title, modelLabel);
  const content = document.createElement("div");
  content.className = "message-content";
  card.append(meta, content);
  transcriptEl.append(card);
  activeMessages.set(`${agent}:${round}`, { card, content });
  scrollIfAppropriate(wasNearBottom);
}
function appendToken({ agent, round, content }) {
  const message = activeMessages.get(`${agent}:${round}`);
  if (!message || typeof content !== "string") return;
  const wasNearBottom = shouldAutoScroll();
  message.content.append(document.createTextNode(content));
  scrollIfAppropriate(wasNearBottom);
}
function completeMessage({ agent, round }) {
  const message = activeMessages.get(`${agent}:${round}`);
  if (message) message.card.classList.add("complete");
}
function parseSseEvents(buffer, onEvent) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() || "";
  for (const part of parts) {
    let event = "message";
    const data = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) onEvent(event, JSON.parse(data.join("\n")));
  }
  return remainder;
}
function handleStreamEvent(event, data) {
  if (event === "status") setStatus(data.message || "Working...");
  if (event === "message_start") createMessageCard(data);
  if (event === "token") appendToken(data);
  if (event === "message_end") completeMessage(data);
  if (event === "done") setStatus(data.message || "Conversation completed");
  if (event === "error") throw new Error(data.message || "The AI service could not complete the conversation.");
}
async function startConversation(event) {
  event.preventDefault();
  setError();
  if (!validateSelectedModels()) { setError("Choose approved models for both agents before starting."); return; }
  setRunning(true);
  setStatus("Starting conversation...");
  const controller = new AbortController();
  let timeoutId;
  const resetTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
  };
  resetTimeout();
  try {
    const response = await fetch(`${WORKER_URL}/debate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: topicInput.value.trim(), rounds: Number(roundsInput.value), agentAModel: agentAModelSelect.value, agentBModel: agentBModelSelect.value }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error("The conversation could not be started.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseEvents(buffer, (name, data) => { resetTimeout(); handleStreamEvent(name, data); });
    }
    buffer += decoder.decode();
    parseSseEvents(`${buffer}\n\n`, (name, data) => { resetTimeout(); handleStreamEvent(name, data); });
  } catch (error) {
    setError(error.name === "AbortError" ? "The conversation stopped because no stream activity was received." : error.message || "The AI service could not complete the conversation.");
  } finally {
    clearTimeout(timeoutId);
    setRunning(false);
  }
}

form.addEventListener("submit", startConversation);
clearButton.addEventListener("click", () => {
  transcriptEl.textContent = "";
  activeMessages = new Map();
  setError();
  if (!running) setStatus("Ready");
});
loadModels();
