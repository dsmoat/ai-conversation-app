# AI Conversation App

A cloud-hosted browser application plus Cloudflare Worker backend where one configurable AI agent can answer normally, or multiple configurable agents can run a structured research discussion. Responses stream from Cloudflare Workers AI through the Worker to the browser with English/Japanese UI text, theme switching, per-agent roles/objectives, per-agent models, temperature, reasoning settings, and a final evaluator synthesis.

## Files

The application is intentionally small:

- `index.html` — accessible browser UI.
- `styles.css` — responsive layout and focus styles.
- `script.js` — model loading, dynamic add/remove agent controls, bilingual UI text, theme switching, streamed `fetch()` handling, character/reasoning statistics, and safe transcript rendering.
- `backend/worker.js` — Cloudflare Worker routes, CORS, model allowlist, and Workers AI orchestration.
- `wrangler.toml` — Worker configuration with an AI binding.

## Cloud-only deployment path

You do not need to install anything locally to run the app in production. Use Cloudflare's hosted dashboards and Git integration:

1. Put this repository in GitHub or another Git provider supported by Cloudflare.
2. In Cloudflare, create a Worker from the repository and use `backend/worker.js` as the Worker entry point.
3. Ensure the Worker has a Workers AI binding named `AI`; the repository's `wrangler.toml` documents that binding.
4. Deploy the static frontend files (`index.html`, `styles.css`, and `script.js`) with Cloudflare Pages or another static host.
5. Configure the frontend's Worker URL. This repository is currently configured for the deployed Worker at `https://ai-conversation-app.kanglou-soon.workers.dev`. If you deploy your own Worker URL, update the `window.WORKER_URL` snippet in `index.html`. If the frontend and Worker are on the same origin, the snippet can be removed because `script.js` defaults to `window.location.origin`.

   ```html
   <script>
     window.WORKER_URL = "https://your-worker.your-account.workers.dev";
   </script>
   <script src="script.js"></script>
   ```

6. Keep the Worker `ALLOWED_ORIGIN` value aligned with the exact deployed frontend origin. This repository currently persists `https://dsmoat.github.io` in `wrangler.toml` so Cloudflare redeploys do not remove the GitHub Pages origin.
7. Test the Worker backend directly with `/health` and `/models`, then open the deployed frontend URL in a browser and confirm the model selectors load.

Do not put Cloudflare API tokens, provider keys, or secrets in this repository. Deployment is intentionally manual and cloud-based; this project does not require local installation to run.

## How streaming works

The browser starts a conversation with `POST /debate`. Because this is a POST request, the browser uses streamed `fetch()` rather than `EventSource`. `script.js` reads `response.body.getReader()`, decodes bytes with `TextDecoder`, parses Server-Sent Events incrementally, and appends model tokens with text-only DOM operations.

The Worker calls Workers AI with `stream: true`, converts Workers AI stream chunks into named SSE events, and forwards them to the browser:

- `status`
- `message_start`
- `token`
- `message_end`
- `done`
- `error`

Agent orchestration remains sequential: Agent A streams and completes, the completed text is saved to conversation history, then Agent B starts. The next round begins only after both agents complete the previous round.

## Model selection and security

Models are loaded from `GET /models`. The Worker uses a server-side `SUPPORTED_MODELS` allowlist and returns the IDs, friendly names, and reasoning capability metadata needed by the frontend. GPT-OSS models are included. The frontend validates selected values against the loaded list, and the backend validates them again against `SUPPORTED_MODELS` before calling `env.AI.run()`.

The frontend cannot submit arbitrary model IDs, external provider URLs, API keys, custom system prompts, or custom token limits. Editing the browser request to use an unapproved model returns HTTP 400.

Cloudflare's model catalog changes. Review the allowlist in `backend/worker.js` when Cloudflare adds, changes, or deprecates Workers AI models. Model-catalog automation may be a future improvement, but this app does not call Cloudflare account model-search APIs dynamically because that would require a Cloudflare API token.

## Usage controls

- Minimum response target: approximately 20 tokens.
- Maximum response limit: 1,000 generated tokens per agent turn.
- Maximum six agent responses per conversation because three rounds are allowed.
- Exact minimum-token enforcement is approximate because the app does not include a tokenizer.
- The 1,000-token maximum is passed to Workers AI through `max_tokens: 1000`.
- Larger output limits increase execution time and Workers AI usage.
- The Worker keeps the topic and most recent transcript messages when building each model request; oldest transcript messages are omitted first if truncation is required.
- One agent is used by default for a normal user-to-agent conversation; add/remove buttons enable multi-agent discussions.
- Each agent has a distinct name, role, objective, model, temperature, reasoning mode, and reasoning-token budget. Unsupported reasoning settings are disabled automatically based on model metadata.
- Multi-agent runs separate exploration, evaluation, revision, and final synthesis. The final evaluator assesses accuracy, depth, novelty, and practical usefulness and produces conclusions, evidence, disagreements, recommendations, limitations, and next steps.
- Agent instructions require concise, relevant, fact-based responses; citations or evidence for verifiable claims when available; unsupported claims labeled as assumptions, inferences, or uncertainties; competing hypotheses; supporting evidence and counterevidence; useful analogies; and shared records of facts, sources, assumptions, disputes, and unknowns.
- Users can include uploaded-document text, URLs, API notes, calculator results, code output, or other tool context in the topic field. The app does not secretly use external API keys.
- The frontend displays streamed character counts for each response and shows reasoning-token counts when the model reports them.

## Worker routes

- `GET /health` — health check JSON.
- `GET /models` — approved model list and defaults.
- `POST /debate` — streamed SSE conversation.
- `OPTIONS` — CORS preflight.

Unsupported methods return HTTP 405. Unknown routes return HTTP 404. Normal JSON responses and streamed responses include CORS headers.

## Optional checks

Automated checks are available for maintainers who choose to run them in a development environment or CI:

```bash
npm test
npm run check:syntax
```

The test suite checks dynamic agent controls, GPT-OSS availability, reasoning metadata and budgets, one-agent default mode, multi-agent ordering, final evaluator output, arbitrary model rejection, streamed counts, text-only token rendering, CORS rejection, and visible per-agent role/objective/temperature/reasoning controls.

## Future improvements

- Automate model-catalog review while preserving the no-token runtime architecture.
- Add optional user-controlled cancellation for active streams.
- Add persistent transcript export.
