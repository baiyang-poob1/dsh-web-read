# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Reporting a vulnerability

Please **do not** open a public issue for a security bypass.

Use GitHub's **Report a vulnerability** / private security advisory for this repository, and include:

- the affected version and platform;
- a minimal URL or reproduction (redact any private hostnames and credentials);
- whether the issue is an SSRF bypass, a sandbox escape, an output leak, or a denial of service;
- any observed response (`status` / `error.code`) that differs from the security model below.

## Security model

`dsh-web-read` exposes one model-facing tool, `web_read`. The model sees its JSON Schema only. The Host adapter validates arguments and spawns an isolated worker; the worker owns all network access and the headless browser.

- **Default-deny network:** only `http`/`https`, an explicit port list (default 80/443), and public unicast destinations. Loopback, RFC1918, link-local, CGNAT, cloud metadata, multicast and reserved ranges are rejected.
- **SSRF:** a per-run loopback proxy resolves each destination and connects to the vetted IP. Redirects and subresources are revalidated. Any blocked A/AAAA record rejects the whole host.
- **No ambient credentials:** the worker gets an allowlisted environment, no workspace path and no Harness service. HTTP cookies/authorization headers are stripped; HTTPS uses a fresh temporary browser profile with no host credentials.
- **Sandbox limits:** the browser is headless with a temporary profile; downloads, popups, permission prompts, WebRTC non-proxied UDP and QUIC are disabled. `text`/`html` modes execute no page JavaScript.
- **Output:** only fixed JSON fields are returned. Raw DOM/event objects, cookies, request/response headers, localStorage and inline script bodies are not returned.
- **Limits:** overall timeout, per-response/total transfer budgets, UTF-8 content cap and a 4 MiB worker-result cap.

### Known boundaries

This is **process isolation plus the browser's own sandbox**, not an OS account/container/Job Object boundary. A browser 0-day remains in scope of the browser's attack surface. The plugin only permits GET/HEAD/OPTIONS, but GET can still have side effects on poorly designed sites. HTTPS tunnel cookies belong to the ephemeral browser profile; they are never injected from the Host and never returned.

## Out of scope

- Vulnerabilities in Microsoft Edge, Google Chrome or the target website itself.
- Content-level prompt injection in a page returned as `content`; treat page text as untrusted data.
- Access to private networks, authenticated sessions, downloads or file uploads, which the plugin deliberately does not support.
