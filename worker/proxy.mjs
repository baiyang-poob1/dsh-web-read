/**
 * dsh-web-read / worker/proxy.mjs
 *
 * 每次读取专属的本地 HTTP 代理。浏览器被强制把全部 HTTP(S) 流量送到这里；
 * 代理对每个请求（包括重定向和子资源）重新做域名/IP/端口校验，并直接连接
 * 已校验的 IP，避免 DNS rebinding。HTTPS 使用 CONNECT 透传，TLS 仍由浏览器
 * 与目标站点端到端完成，不做 MITM。
 */

import http from 'node:http'
import net from 'node:net'

import { createDestinationGuard, PolicyError } from './policy.mjs'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function sanitizeRequestHeaders(input, parsed) {
  const headers = {}
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    if (key === 'authorization' || key === 'proxy-authorization') continue
    if (key === 'cookie' || key === 'cookie2') continue
    if (key === 'host') continue
    if (value !== undefined) headers[key] = value
  }
  headers.host = parsed.host
  return headers
}

function sanitizeResponseHeaders(input) {
  const headers = {}
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    // 不把认证挑战或任何 Cookie 交给页面，避免出现登录/凭据状态。
    if (key === 'www-authenticate' || key === 'proxy-authenticate') continue
    if (key === 'set-cookie' || key === 'set-cookie2') continue
    // 内容长度可能因截断而不再准确，交给 Node 使用 chunked。
    if (key === 'content-length') continue
    if (value !== undefined) headers[key] = value
  }
  return headers
}

function parseAuthority(authority) {
  const raw = String(authority ?? '')
  let host = ''
  let port = ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return null
    host = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (!rest.startsWith(':')) return null
    port = rest.slice(1)
  } else {
    const index = raw.lastIndexOf(':')
    if (index <= 0) return null
    host = raw.slice(0, index)
    port = raw.slice(index + 1)
  }
  if (!/^\d{1,5}$/.test(port)) return null
  const portNumber = Number(port)
  if (portNumber < 1 || portNumber > 65535) return null
  return { host, port: portNumber }
}

const POLICY_CODE_BY_MESSAGE = new Map([
  ['INVALID_URL', 400],
  ['UNSUPPORTED_PROTOCOL', 403],
  ['URL_CREDENTIALS', 403],
  ['PORT_BLOCKED', 403],
  ['DOMAIN_BLOCKED', 403],
  ['DOMAIN_NOT_ALLOWED', 403],
  ['SSRF_BLOCKED', 403],
  ['DNS_FAILED', 502],
  ['DNS_TIMEOUT', 504],
])

export async function startGuardProxy(options = {}) {
  const guard = createDestinationGuard(options)
  const deadline = Number(options.deadline) || (Date.now() + 10000)
  const maxBytes = Math.min(1_000_000, Math.max(1000, Number(options.maxBytes) || 200000))
  const maxResponseBytes = Math.min(8_000_000, Math.max(2_000_000, maxBytes * 4))
  const totalBudget = Math.min(32_000_000, Math.max(8_000_000, maxBytes * 12))

  const stats = {
    requests: 0,
    tunnels: 0,
    blocked: 0,
    blockedRequests: [],
    bytesToClient: 0,
    bytesFromClient: 0,
    truncated: false,
    exhausted: false,
    maxEntryBytes: 0,
  }

  const sockets = new Set()

  const recordBlock = (host, port, code) => {
    stats.blocked += 1
    if (stats.blockedRequests.length < 50) stats.blockedRequests.push({ host, port, code })
  }

  const sendBlocked = (res, error, fallbackStatus = 403) => {
    const code = error instanceof PolicyError ? error.code : 'PROXY_ERROR'
    const status = error instanceof PolicyError ? (POLICY_CODE_BY_MESSAGE.get(code) ?? fallbackStatus) : 502
    recordBlock('unknown', 0, code)
    if (!res.headersSent) {
      const body = `Blocked by web_read policy (${code})\n`
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-dsh-web-read-blocked': '1',
        'x-dsh-web-read-code': code,
        'cache-control': 'no-store',
      })
      res.end(body)
    } else {
      res.destroy()
    }
  }

  const budgetExceeded = (extra = 0) => {
    if (stats.bytesToClient + stats.bytesFromClient + extra > totalBudget) {
      stats.exhausted = true
      stats.truncated = true
      return true
    }
    return false
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      if (!res.headersSent) sendBlocked(res, error)
      else res.destroy()
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  async function handleHttp(req, res) {
    stats.requests += 1
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      recordBlock('unknown', 0, 'METHOD_NOT_ALLOWED')
      const body = 'Blocked by web_read policy (METHOD_NOT_ALLOWED)\n'
      res.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-dsh-web-read-blocked': '1',
        'x-dsh-web-read-code': 'METHOD_NOT_ALLOWED',
      })
      res.end(body)
      return
    }
    if (req.headers.upgrade) {
      recordBlock('unknown', 0, 'UPGRADE_NOT_ALLOWED')
      return sendBlocked(res, new PolicyError('PROTOCOL_BLOCKED', 'WebSocket upgrade is not allowed.', 'blocked'))
    }

    let parsed
    try {
      parsed = new URL(req.url)
    } catch {
      return sendBlocked(res, new PolicyError('INVALID_URL', 'Proxy request URL is invalid.', 'invalid_request'), 400)
    }
    if (parsed.protocol !== 'http:') {
      return sendBlocked(res, new PolicyError('UNSUPPORTED_PROTOCOL', 'Only http is proxied here.', 'blocked'))
    }

    let destination
    try {
      destination = await guard.checkUrl(parsed.href, deadline)
    } catch (error) {
      const code = error instanceof PolicyError ? error.code : 'POLICY_ERROR'
      recordBlock(parsed.hostname, Number(parsed.port) || 80, code)
      return sendBlocked(res, error)
    }

    const remaining = Math.max(1, deadline - Date.now())
    if (remaining <= 1) {
      return sendBlocked(res, new PolicyError('TIMEOUT', 'Request exceeded the overall deadline.', 'timeout'), 504)
    }

    const headers = sanitizeRequestHeaders(req.headers, parsed)
    const upstream = http.request({
      host: destination.address,
      family: destination.family,
      port: destination.port,
      method: req.method,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      agent: false,
    })

    let finished = false
    let sentBytes = 0

    const fail = (error) => {
      if (finished) return
      finished = true
      upstream.destroy()
      if (!res.headersSent) {
        sendBlocked(res, error instanceof PolicyError ? error : new PolicyError('UPSTREAM_FAILED', 'Upstream request failed.', 'network_error'))
      } else {
        res.destroy()
      }
    }

    upstream.setTimeout(Math.min(15000, remaining), () => {
      fail(new PolicyError('UPSTREAM_TIMEOUT', 'Upstream request timed out.', 'timeout'))
    })

    upstream.on('response', (upstreamRes) => {
      const headersOut = sanitizeResponseHeaders(upstreamRes.headers)
      headersOut['cache-control'] = 'no-store'
      res.writeHead(upstreamRes.statusCode ?? 502, headersOut)

      upstreamRes.on('data', (chunk) => {
        if (finished) return
        const left = maxResponseBytes - sentBytes
        if (left <= 0) {
          stats.truncated = true
          finished = true
          upstreamRes.destroy()
          res.end()
          return
        }
        const out = chunk.length > left ? chunk.subarray(0, left) : chunk
        sentBytes += out.length
        stats.bytesToClient += out.length
        stats.maxEntryBytes = Math.max(stats.maxEntryBytes, sentBytes)
        if (budgetExceeded()) {
          stats.truncated = true
          finished = true
          upstreamRes.destroy()
          res.destroy()
          return
        }
        const more = res.write(out)
        if (!more) upstreamRes.pause()
        if (chunk.length > left) {
          stats.truncated = true
          finished = true
          upstreamRes.destroy()
          res.end()
        }
      })
      res.on('drain', () => upstreamRes.resume())
      upstreamRes.on('end', () => {
        if (!finished) {
          finished = true
          res.end()
        }
      })
      upstreamRes.on('error', () => {
        if (!finished) {
          finished = true
          res.destroy()
        }
      })
    })

    upstream.on('error', (error) => fail(error))
    res.on('close', () => {
      if (!finished) {
        finished = true
        upstream.destroy()
      }
    })
    req.on('aborted', () => upstream.destroy())
    req.resume()
    upstream.end()
  }

  function handleConnect(req, clientSocket, head) {
    stats.tunnels += 1
    clientSocket.on('error', () => {})

    const authority = parseAuthority(req.url)
    if (!authority) {
      recordBlock('unknown', 0, 'INVALID_AUTHORITY')
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    guard.checkHost(authority.host, authority.port, deadline).then((destination) => {
      if (clientSocket.destroyed) return
      if (deadline - Date.now() <= 1) {
        recordBlock(destination.host, destination.port, 'TIMEOUT')
        clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n')
        return
      }
      const upstream = net.connect({
        host: destination.address,
        family: destination.family,
        port: destination.port,
      })
      upstream.setNoDelay(true)
      clientSocket.setNoDelay(true)
      let connected = false

      const remaining = Math.max(1, deadline - Date.now())
      upstream.setTimeout(Math.min(30000, remaining), () => {
        upstream.destroy()
        clientSocket.destroy()
      })
      clientSocket.setTimeout(Math.min(30000, remaining), () => {
        upstream.destroy()
        clientSocket.destroy()
      })

      upstream.once('connect', () => {
        connected = true
        if (clientSocket.destroyed) {
          upstream.destroy()
          return
        }
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-web-read\r\n\r\n')
        if (head && head.length > 0) upstream.write(head)

        clientSocket.on('data', (chunk) => {
          stats.bytesFromClient += chunk.length
          if (budgetExceeded()) {
            stats.truncated = true
            stats.exhausted = true
            upstream.destroy()
            clientSocket.destroy()
          }
        })
        upstream.on('data', (chunk) => {
          stats.bytesToClient += chunk.length
          if (budgetExceeded()) {
            stats.truncated = true
            stats.exhausted = true
            upstream.destroy()
            clientSocket.destroy()
          }
        })

        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)
        upstream.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => upstream.destroy())
        clientSocket.on('close', () => upstream.destroy())
        upstream.on('close', () => clientSocket.destroy())
      })

      upstream.once('error', (error) => {
        if (connected) return
        recordBlock(destination.host, destination.port, 'UPSTREAM_FAILED')
        if (!clientSocket.destroyed) {
          const body = `Blocked by web_read policy (UPSTREAM_FAILED)\n`
          clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
        }
        void error
      })
    }).catch((error) => {
      const code = error instanceof PolicyError ? error.code : 'POLICY_ERROR'
      recordBlock(authority.host, authority.port, code)
      if (!clientSocket.destroyed) {
        const body = `Blocked by web_read policy (${code})\n`
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      }
    })
  }

  server.on('connect', handleConnect)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('proxy failed to bind')
  }

  return {
    port: address.port,
    stats,
    guard,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
