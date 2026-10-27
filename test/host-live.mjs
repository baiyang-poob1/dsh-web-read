/**
 * Manual end-to-end smoke test for the Host+worker path.
 * Requires network + a usable Edge/Chrome and must run outside the DSH workspace
 * file sandbox (Chromium needs named pipes). Not part of `node --test`.
 *
 *   node test/host-live.mjs https://example.com/ text
 *   node test/host-live.mjs https://chat.deepseek.com/share/... js
 */

import { apply } from '../lib/index.js'

const url = process.argv[2] ?? 'https://example.com/'
const mode = process.argv[3] ?? 'text'
const tools = []
const ctx = {
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  effect(callback) {
    return callback()
  },
}

apply(ctx, { maxConcurrency: 1 })
const tool = tools[0]
const controller = new AbortController()
const result = await tool.execute({
  url,
  mode,
  timeout_ms: 30000,
  max_bytes: 500000,
  include_links: true,
}, { signal: controller.signal })

const summary = {
  status: result.status,
  error: result.error ?? null,
  url_final: result.url_final,
  title: result.title,
  content_type: result.content_type,
  truncated: result.truncated,
  content_chars: typeof result.content === 'string' ? result.content.length : null,
  content_head: typeof result.content === 'string' ? result.content.slice(0, 300) : null,
  links: Array.isArray(result.links) ? result.links.length : null,
  scripts: result.scripts ? {
    external: result.scripts.external_count,
    inline: result.scripts.inline_count,
    dynamic: result.scripts.dynamic?.detected,
  } : null,
}
console.log(JSON.stringify(summary, null, 2))
