import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PolicyError,
  createDestinationGuard,
  domainMatches,
  isBlockedIp,
  normalizeHost,
  validateUrlShape,
} from '../worker/policy.mjs'

test('isBlockedIp rejects loopback, RFC1918, metadata and special ranges', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ]
  for (const ip of blocked) {
    assert.ok(isBlockedIp(ip), `${ip} should be blocked`)
  }
})

test('isBlockedIp allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIp(ip), null, `${ip} should be allowed`)
  }
})

test('normalizeHost handles brackets, IDN and trailing dots', () => {
  assert.equal(normalizeHost('[::1]'), '::1')
  assert.equal(normalizeHost('Example.COM.'), 'example.com')
  assert.equal(normalizeHost('例子.测试'), 'xn--fsqu00a.xn--0zwm56d')
  assert.equal(normalizeHost(''), '')
})

test('domainMatches supports exact, wildcard and suffix forms', () => {
  assert.equal(domainMatches('example.com', 'example.com'), true)
  assert.equal(domainMatches('api.example.com', '*.example.com'), true)
  assert.equal(domainMatches('example.com', '*.example.com'), false)
  assert.equal(domainMatches('api.example.com', '.example.com'), true)
  assert.equal(domainMatches('example.org', 'example.com'), false)
})

test('validateUrlShape enforces protocol, credentials and port policy', () => {
  const https = validateUrlShape('https://example.com/a?b=1', { allowedPorts: [80, 443] })
  assert.equal(https.host, 'example.com')
  assert.equal(https.port, 443)

  const custom = validateUrlShape('http://example.com:8080/', { allowedPorts: [8080] })
  assert.equal(custom.port, 8080)

  const cases = [
    ['ftp://example.com/', 'UNSUPPORTED_PROTOCOL'],
    ['file:///C:/secret.txt', 'UNSUPPORTED_PROTOCOL'],
    ['javascript:alert(1)', 'UNSUPPORTED_PROTOCOL'],
    ['http://user:pass@example.com/', 'URL_CREDENTIALS'],
    ['http://example.com:8080/', 'PORT_BLOCKED'],
    ['not-a-url', 'INVALID_URL'],
  ]
  for (const [url, code] of cases) {
    assert.throws(() => validateUrlShape(url, { allowedPorts: [80, 443] }), (error) => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, code)
      return true
    })
  }
})

test('guard rejects loopback and metadata without any HTTP request', async () => {
  const guard = createDestinationGuard({ allowedPorts: [80, 443] })
  for (const [host, port, code] of [
    ['127.0.0.1', 80, 'SSRF_BLOCKED'],
    ['169.254.169.254', 80, 'SSRF_BLOCKED'],
    ['10.0.0.1', 443, 'SSRF_BLOCKED'],
    ['::1', 80, 'SSRF_BLOCKED'],
    ['localhost', 80, 'DOMAIN_BLOCKED'],
    ['metadata.google.internal', 80, 'DOMAIN_BLOCKED'],
    ['127.0.0.1', 8080, 'PORT_BLOCKED'],
  ]) {
    await assert.rejects(guard.checkHost(host, port, Date.now() + 2000), (error) => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, code)
      return true
    })
  }
})

test('guard enforces allow and deny domain lists before DNS', async () => {
  const only = createDestinationGuard({ allowedDomains: ['example.com'], deniedDomains: [] })
  await assert.rejects(only.checkHost('example.org', 443, Date.now() + 2000), (error) => {
    assert.equal(error.code, 'DOMAIN_NOT_ALLOWED')
    return true
  })

  const denied = createDestinationGuard({ allowedDomains: [], deniedDomains: ['*.example.com'] })
  await assert.rejects(denied.checkHost('sub.example.com', 443, Date.now() + 2000), (error) => {
    assert.equal(error.code, 'DOMAIN_BLOCKED')
    return true
  })
})

test('guard allows a public literal IP', async () => {
  const guard = createDestinationGuard({ allowedPorts: [80, 443] })
  const destination = await guard.checkHost('8.8.8.8', 443, Date.now() + 2000)
  assert.equal(destination.address, '8.8.8.8')
  assert.equal(destination.family, 4)
})
