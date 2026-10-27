# Changelog

## 1.0.0 — 2026-10-27

Initial public release.

- One model-facing tool: `web_read`.
- Modes: `text` (static readable text), `html` (sanitized simplified HTML), `js` (headless-rendered text plus script inspection).
- Readability-style main-content extraction, navigation/boilerplate removal and HTML allowlist sanitization.
- Per-run loopback HTTP(S) proxy with DNS/IP validation, pinned destination IPs, redirect/subresource checks and default-deny SSRF policy.
- Independent worker process; Host does not access target URLs or expose filesystem/process/environment APIs.
- Headless Edge/Chrome with temporary profile, disabled downloads/popups/permissions, and optional JavaScript execution only in `mode=js`.
- Structured JSON results: `status`, `url_final`, `title`, `content`, `content_type`, `truncated`, optional `links`/`scripts`, and `error`.
- Timeout, transfer, content-byte and worker-result limits; UTF-8-safe truncation.
- Unit tests for SSRF policy, Host contract, and the DSH JSON Schema subset; optional live smoke test.
- Fix: Host hard-stop timer reads the protocol's `timeout_ms` field (not `timeoutMs`), preventing an immediate false timeout/cancel of every worker.
