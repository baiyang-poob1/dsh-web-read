import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name, workerHardStopMs } from '../lib/index.js'

function fakeContext() {
  const tools = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    effect(callback) {
      return callback()
    },
  }
  return { ctx, tools }
}

test('plugin contract and tool schema', () => {
  assert.equal(name, 'tool-web-read')
  assert.deepEqual(inject, ['tools'])
  const { ctx, tools } = fakeContext()
  apply(ctx, { maxConcurrency: 1 })
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'web_read')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['url'])
  assert.deepEqual(tool.parameters.properties.mode.enum, ['text', 'html', 'js'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.timeoutMs, 35000)
})

test('host-side argument rejection never starts a worker', async () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, {})
  const tool = tools[0]
  const signal = new AbortController().signal

  const ftp = await tool.execute({ url: 'ftp://example.com/' }, { signal })
  assert.equal(ftp.status, 'blocked')
  assert.equal(ftp.error.code, 'UNSUPPORTED_PROTOCOL')

  const credentials = await tool.execute({ url: 'https://user:pass@example.com/' }, { signal })
  assert.equal(credentials.status, 'blocked')
  assert.equal(credentials.error.code, 'URL_CREDENTIALS')

  const badMode = await tool.execute({ url: 'https://example.com/', mode: 'pdf' }, { signal })
  assert.equal(badMode.status, 'invalid_request')
  assert.equal(badMode.error.code, 'INVALID_MODE')

  const big = await tool.execute({ url: 'https://example.com/', max_bytes: 2_000_000 }, { signal })
  assert.equal(big.status, 'invalid_request')
  assert.equal(big.error.code, 'INVALID_MAX_BYTES')
})

test('worker hard stop uses the snake_case protocol timeout', () => {
  assert.equal(workerHardStopMs({ timeout_ms: 12000 }), 16000)
  assert.equal(workerHardStopMs({ timeout_ms: 1000 }), 5000)
  assert.equal(workerHardStopMs({ timeout_ms: 99999 }), 34000)
  // Regression: the Host request has `timeout_ms`, not `timeoutMs`. Reading the
  // camelCase field yielded undefined, NaN, and an immediate false timeout.
  assert.equal(workerHardStopMs({ timeoutMs: 1000 }), 14000)
  assert.equal(workerHardStopMs({}), 14000)
})

test('rendered result is JSON content', () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, {})
  const content = tools[0].output.render({}, { status: 'ok', content: 'hello' })
  assert.equal(content[0].type, 'text')
  assert.deepEqual(JSON.parse(content[0].text), { status: 'ok', content: 'hello' })
})
