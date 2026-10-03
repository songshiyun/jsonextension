# JSON Lens — approved design

The user approved this scope after a grill-me interview, ending with “a” to the final implementation confirmation.

## Product

A Manifest V3 Chrome extension with a Chinese interface and system light/dark theme. JSON responses are enhanced in place. The toolbar opens a standalone editor. Two selection context menus independently format standard JSON or explicitly invoke an OpenAI-compatible LLM. The editor has source and tree panes, editable JSON, error locations, folding, search, path copying, formatting, minification, download and multiple-result switching.

Formatting preserves literal numbers, string escapes, original member order and duplicate members. Invalid or truncated JSON is rejected, not silently repaired. AI may identify objects and arrays in prose, fences and escaped JSON, but may not invent content. The original selection remains available alongside results.

Local source limit: 5 MiB. AI selection limit: 100 KiB. Two-space formatting. Long trees are rendered in bounded batches. Parsing runs off the UI thread. LLM requests time out and can be cancelled. Errors retain source input.

## Data and permissions

Base URL, API key and model are stored locally, restricted to trusted extension contexts. There is no persistent source/result history or remote telemetry. Selection handoff is transient and consumed by its viewer. Only an explicit AI action sends the selected text to the configured endpoint. API requests run in an extension context with no page access to credentials.

Auto-formatting inspects JSON MIME types and DOM source without refetching the original URL. It does not modify ordinary HTML pages. A restore-original control remains available. Runtime host access is requested for configured API origins where necessary. Pure JSON content detection is tested against application/json and application/*+json.

## Delivery and acceptance

Deliver extension/ as an unpacked extension, dist/ as a build copy, setup documentation, unit tests and a browser smoke test with a local mock LLM. Verify data preservation, malformed input, multiple candidates, source editing, tree search/path copy, cancellation, authentication errors and page enhancement. Real provider credentials belong in the installed extension settings; no real API key is required in the repository or tests.
