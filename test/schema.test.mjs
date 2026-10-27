import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'title', 'description', 'default', 'examples',
])

function visit(node, trail) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => visit(entry, `${trail}[${index}]`))
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      assert.ok(value && typeof value === 'object', `${trail}.properties must be an object`)
      for (const [name, schema] of Object.entries(value)) visit(schema, `${trail}.properties.${name}`)
      continue
    }
    if (key === 'oneOf' || key === 'items') {
      visit(value, `${trail}.${key}`)
      continue
    }
    if (key === 'enum' || key === 'required' || key === 'examples' || key === 'default') continue
    if (!ALLOWED.has(key)) assert.fail(`unsupported schema keyword ${trail}.${key}`)
    if (key === 'additionalProperties' || key === 'title' || key === 'description') continue
    if (key === 'type' || key === 'const') continue
  }
}

for (const file of ['web_read.input.json', 'web_read.output.json']) {
  test(`${file} uses only the DSH JSON Schema subset`, () => {
    const schema = JSON.parse(readFileSync(path.join(ROOT, 'schema', file), 'utf8'))
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    visit(schema, '$')
  })
}

test('input schema exposes the documented model surface', () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'web_read.input.json'), 'utf8'))
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'include_links', 'max_bytes', 'mode', 'timeout_ms', 'url', 'wait_for',
  ])
  assert.deepEqual(schema.required, ['url'])
  assert.deepEqual(schema.properties.mode.enum, ['text', 'html', 'js'])
  assert.equal(schema.properties.mode.default, 'text')
})
