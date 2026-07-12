# AI Conversation App

A cloud-hosted browser application plus Cloudflare Worker backend where two hard-coded AI agents discuss a user-provided topic. Responses stream from Cloudflare Workers AI through the Worker to the browser as each agent generates text.

## Files

The application is intentionally small:

- `index.html` — accessible browser UI.
- `styles.css` — responsive layout and focus styles.
- `script.js` — model loading, streamed `fetch()` handling, and safe transcript rendering.
- `backend/worker.js` — Cloudflare Worker routes, CORS, model allowlist, and Workers AI orchestration.
- `wrangler.toml` — Worker configuration with an AI binding.

## Cloud-only deployment path

You do not need to install anything locally to run the app in production. Use Cloudflare's hosted dashboards and Git integration:

1. Put this repository in GitHub or another Git provider supported by Cloudflare.
2. In Cloudflare, create a Worker from the repository and use `backend/worker.js` as the Worker entry point.
3. Ensure the Worker has a Workers AI binding named `AI`; the repository's `wrangler.toml` documents that binding.
4. Deploy the static frontend files (`index.html`, `styles.css`, and `script.js`) with Cloudflare Pages or another static host.
5. Configure the frontend's Worker URL. If the frontend and Worker are on the same origin, no extra JavaScript configuration is needed because `script.js` defaults to `window.location.origin`. If the Worker is on a different origin, define `window.WORKER_URL` before `script.js` loads, for example:

   ```html
   <script>
     window.WORKER_URL = "https://your-worker.your-account.workers.dev";
   </script>
   <script src="script.js"></script>
   ```

6. Set the Worker `ALLOWED_ORIGIN` environment variable to the exact deployed frontend origin, such as `https://your-pages-site.pages.dev`.
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

Models are loaded from `GET /models`. The Worker uses a server-side `SUPPORTED_MODELS` allowlist and returns only the IDs and friendly names needed by the frontend. The frontend validates selected values against the loaded list, and the backend validates them again against `SUPPORTED_MODELS` before calling `env.AI.run()`.

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

The test suite checks model-selector loading, same-model and different-model conversations, arbitrary model rejection, exclusion of deprecated or non-chat model categories, incremental Agent A output, Agent B ordering, status events, partial output on streaming failure, UI restoration logic, the 1,000-token request limit, `/models` CORS rejection, and safe text-only rendering instead of `innerHTML`.

## Future improvements

- Automate model-catalog review while preserving the no-token runtime architecture.
- Add optional user-controlled cancellation for active streams.
- Add persistent transcript export.
