/**
 * dsh-web-read / worker/policy.mjs
 *
 * URL、域名、端口与 IP 的默认拒绝策略。这个模块只做判断，不发网络请求
 * （除 DNS 解析外）；真正的连接由 proxy.mjs 建立，并固定使用这里校验过的 IP。
 */

import dns from 'node:dns/promises'
import net from 'node:net'
import { domainToASCII } from 'node:url'

export class PolicyError extends Error {
  constructor(code, message, status = 'blocked') {
    super(message)
    this.name = 'PolicyError'
    this.code = code
    this.status = status
  }
}

const IPV4_RANGES = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private-network'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private-network'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private-network'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]

const IPV6_RANGES = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['100::', 64, 'discard-only'],
  ['2001::', 32, 'teredo'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:10::', 28, 'orchid'],
  ['2001:20::', 28, 'orchid'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'srv6-sid'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
]

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  'metadata.tencentyun.com',
  'metadata.aliyun.com',
  'metadata.oraclecloud.com',
])

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.corp',
]

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    value = (value * 256) + n
  }
  return value >>> 0
}

function inIpv4Range(value, base, bits) {
  const baseValue = ipv4ToInt(base)
  if (baseValue === null) return false
  const size = 2 ** (32 - bits)
  return Math.floor(value / size) === Math.floor(baseValue / size)
}

function parseIpv6(raw) {
  let value = String(raw).trim().toLowerCase()
  value = value.replace(/^\[/, '').replace(/\]$/, '')
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (!value || value.includes(':::')) return null

  let head = []
  let tail = []
  if (value.includes('::')) {
    const pieces = value.split('::')
    if (pieces.length !== 2) return null
    head = pieces[0] ? pieces[0].split(':') : []
    tail = pieces[1] ? pieces[1].split(':') : []
  } else {
    head = value.split(':')
    if (head.length !== 8) return null
  }

  const expandDotted = (parts) => {
    if (parts.length === 0) return parts
    const last = parts[parts.length - 1]
    if (!last.includes('.')) return parts
    const v4 = ipv4ToInt(last)
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    return [...parts.slice(0, -1), hi, lo]
  }

  head = expandDotted(head)
  tail = expandDotted(tail)
  if (head === null || tail === null) return null
  if (value.includes('::')) {
    const zeros = 8 - head.length - tail.length
    if (zeros < 1) return null
    head = [...head, ...Array(zeros).fill('0'), ...tail]
  }
  if (head.length !== 8) return null

  let result = 0n
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    result = (result << 16n) | BigInt(parseInt(group, 16))
  }
  return result
}

function ipv6Groups(raw) {
  const value = parseIpv6(raw)
  if (value === null) return null
  return Object.freeze({ value })
}

function inIpv6Range(value, base, bits) {
  const baseValue = parseIpv6(base)
  if (baseValue === null) return false
  const shift = 128n - BigInt(bits)
  return (value >> shift) === (baseValue >> shift)
}

function ipv4FromBigInt(value) {
  return `${Number((value >> 24n) & 0xffn)}.${Number((value >> 16n) & 0xffn)}.${Number((value >> 8n) & 0xffn)}.${Number(value & 0xffn)}`
}

/**
 * 返回阻断原因；公网可路由地址返回 null。
 * 对无法解析的 IP 采取 fail-closed。
 */
export function isBlockedIp(ip) {
  const family = net.isIP(ip)
  if (family === 4) {
    const value = ipv4ToInt(ip)
    if (value === null) return 'unparseable-ip'
    if (value === ipv4ToInt('169.254.169.254')) return 'cloud-metadata'
    for (const [base, bits, reason] of IPV4_RANGES) {
      if (inIpv4Range(value, base, bits)) return reason
    }
    return null
  }

  if (family === 6) {
    const parsed = ipv6Groups(ip)
    if (!parsed) return 'unparseable-ip'
    const value = parsed.value

    // IPv4-mapped / IPv4-compatible / NAT64 / 6to4：先检查内嵌的 IPv4。
    if ((value >> 32n) === 0xffffn) {
      return isBlockedIp(ipv4FromBigInt(value & 0xffffffffn)) ?? 'ipv4-mapped'
    }
    if (inIpv6Range(value, '64:ff9b::', 96)) {
      return isBlockedIp(ipv4FromBigInt(value & 0xffffffffn)) ?? null
    }
    if (inIpv6Range(value, '64:ff9b:1::', 48)) return 'nat64-local-use'
    if (inIpv6Range(value, '::', 96)) return 'ipv4-compatible'
    if (inIpv6Range(value, '2002::', 16)) {
      const embedded = (value >> 80n) & 0xffffffffn
      return isBlockedIp(ipv4FromBigInt(embedded)) ?? '6to4'
    }

    for (const [base, bits, reason] of IPV6_RANGES) {
      if (inIpv6Range(value, base, bits)) return reason
    }
    return null
  }

  return 'unparseable-ip'
}

export function normalizeHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.$/, '')
  if (net.isIP(host)) return host
  const ascii = domainToASCII(host)
  return ascii ? ascii.toLowerCase() : ''
}

function patternMatches(host, pattern) {
  const p = normalizePattern(pattern)
  if (!p) return false
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1
  if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p)
  return host === p
}

export function domainMatches(hostInput, pattern) {
  const host = normalizeHost(hostInput)
  return Boolean(host) && patternMatches(host, pattern)
}

function blockedHostName(host) {
  if (!host) return 'empty-host'
  if (BLOCKED_HOSTNAMES.has(host)) return 'reserved-hostname'
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return 'reserved-hostname'
  return null
}

function normalizePattern(pattern) {
  let value = String(pattern ?? '').trim().toLowerCase()
  let prefix = ''
  if (value.startsWith('*.')) {
    prefix = '*.'
    value = value.slice(2)
  } else if (value.startsWith('.')) {
    prefix = '.'
    value = value.slice(1)
  }
  const host = normalizeHost(value)
  return host ? `${prefix}${host}` : ''
}

function normalizedList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizePattern(item))
    .filter(Boolean)
}

function normalizePorts(value) {
  const defaults = [80, 443]
  if (!Array.isArray(value) || value.length === 0) return new Set(defaults)
  const ports = value
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  return new Set(ports.length > 0 ? ports : defaults)
}

/**
 * 只校验 URL 形状，不做 DNS。用于在启动浏览器前快速失败。
 */
export function validateUrlShape(raw, options = {}) {
  if (typeof raw !== 'string') throw new PolicyError('INVALID_URL', 'url 必须是字符串。', 'invalid_request')
  const text = raw.trim()
  if (text.length === 0 || text.length > 4096) {
    throw new PolicyError('INVALID_URL', 'url 长度必须在 1 到 4096 字符之间。', 'invalid_request')
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new PolicyError('INVALID_URL', 'url 不是合法的绝对地址。', 'invalid_request')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PolicyError('UNSUPPORTED_PROTOCOL', '只允许 http 或 https 协议。', 'blocked')
  }
  if (url.username || url.password) {
    throw new PolicyError('URL_CREDENTIALS', 'url 不能包含用户名或密码。', 'blocked')
  }
  const host = normalizeHost(url.hostname)
  if (!host) throw new PolicyError('INVALID_URL', 'url 缺少有效主机名。', 'invalid_request')
  const ports = normalizePorts(options.allowedPorts)
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  if (!Number.isInteger(port) || !ports.has(port)) {
    throw new PolicyError('PORT_BLOCKED', '目标端口不在允许列表（默认 80/443）中。', 'blocked')
  }
  return { url, host, port }
}

export function createDestinationGuard(options = {}) {
  const allowedDomains = normalizedList(options.allowedDomains)
  const deniedDomains = normalizedList(options.deniedDomains)
  const allowedPorts = normalizePorts(options.allowedPorts)
  const cache = new Map()
  const cacheTtlMs = 30000

  const assertDomain = (host) => {
    const bad = blockedHostName(host)
    if (bad) throw new PolicyError('DOMAIN_BLOCKED', `目标主机被拒绝（${bad}）。`, 'blocked')
    if (deniedDomains.some((pattern) => patternMatches(host, pattern))) {
      throw new PolicyError('DOMAIN_BLOCKED', '目标主机在 deniedDomains 中。', 'blocked')
    }
    if (allowedDomains.length > 0 && !allowedDomains.some((pattern) => patternMatches(host, pattern))) {
      throw new PolicyError('DOMAIN_NOT_ALLOWED', '目标主机不在 allowedDomains 白名单中。', 'blocked')
    }
  }

  const resolve = async (host, deadline) => {
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }]
    const cached = cache.get(host)
    if (cached && cached.expiresAt > Date.now()) return cached.addresses
    const remaining = Math.max(1, deadline - Date.now())
    let timer
    try {
      const result = await Promise.race([
        dns.lookup(host, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new PolicyError('DNS_TIMEOUT', '域名解析超时。', 'timeout')), Math.min(remaining, 5000))
          timer.unref?.()
        }),
      ])
      if (!Array.isArray(result) || result.length === 0) {
        throw new PolicyError('DNS_FAILED', '域名没有可用地址。', 'network_error')
      }
      cache.set(host, { expiresAt: Date.now() + cacheTtlMs, addresses: result })
      return result
    } catch (error) {
      if (error instanceof PolicyError) throw error
      throw new PolicyError('DNS_FAILED', '域名解析失败。', 'network_error')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 校验一个已经解析出来的 host/port。返回的 address 必须固定用于连接，
   * 不能在连接阶段重新解析域名，否则会留下 DNS rebinding 窗口。
   */
  const checkHost = async (hostInput, portInput, deadline = Date.now() + 10000) => {
    const host = normalizeHost(hostInput)
    if (!host) throw new PolicyError('INVALID_URL', '主机名为空。', 'invalid_request')
    const port = Number(portInput)
    if (!Number.isInteger(port) || !allowedPorts.has(port)) {
      throw new PolicyError('PORT_BLOCKED', '目标端口不在允许列表中。', 'blocked')
    }
    assertDomain(host)
    const addresses = await resolve(host, deadline)
    for (const entry of addresses) {
      const reason = isBlockedIp(entry.address)
      if (reason) {
        throw new PolicyError('SSRF_BLOCKED', `目标解析到受限地址（${reason}）。`, 'blocked')
      }
    }
    const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0]
    return { host, port, address: chosen.address, family: chosen.family, addresses }
  }

  const checkUrl = async (url, deadline) => {
    const shape = validateUrlShape(url, { allowedPorts: [...allowedPorts] })
    return checkHost(shape.host, shape.port, deadline)
  }

  return { checkUrl, checkHost, allowedDomains, deniedDomains, allowedPorts }
}

export const BUILTIN_PORTS = Object.freeze([80, 443])
