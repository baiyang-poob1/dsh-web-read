/**
 * dsh-web-read / worker/main.mjs
 *
 * 独立沙箱进程入口。协议：stdin 一行 JSON 请求；stdout 一行 JSON 结果。
 * 第二行可以是 {"type":"cancel"}，用于宿主取消/超时后让 worker 自行清理浏览器。
 *
 * 这个进程不读取工作区、不接触 Harness Service、不接收任何宿主凭据；
 * 环境变量由宿主白名单化，页面正文只通过结构化字段经 stdout 返回。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { launchBrowser } from './browser.mjs'
import { WebReadError, toPublicError } from './errors.mjs'
import { PolicyError, validateUrlShape } from './policy.mjs'
import { startGuardProxy } from './proxy.mjs'

const MAX_REQUEST_BYTES = 128 * 1024
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 30000
const MIN_BYTES = 1000
const MAX_BYTES = 1000000
const ALLOWED_MODES = new Set(['text', 'html', 'js'])

let emitted = false
let activeController = null

function writeResult(value) {
  if (emitted) return
  emitted = true
  const text = `${JSON.stringify(value)}\n`
  process.stdout.write(text, () => {
    setTimeout(() => process.exit(0), 20)
  })
}

function emptyResult(status, code, message, extra = {}) {
  return {
    status,
    url_final: null,
    title: null,
    content: null,
    content_type: null,
    truncated: false,
    ...extra,
    error: { code, message },
  }
}

function sanitizeControl(value, maxChars) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}

function clampInt(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function normalizeStringList(value, limit = 100) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => item.slice(0, 253))
}

function normalizePorts(value) {
  if (!Array.isArray(value) || value.length === 0) return [80, 443]
  const ports = [...new Set(value.map((port) => Number(port)).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
  return ports.length > 0 ? ports.slice(0, 10) : [80, 443]
}

function sanitizeFinalUrl(value) {
  if (!value) return null
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.href.slice(0, 4096)
  } catch {
    return null
  }
}

function sanitizeMime(value) {
  const text = String(value ?? '').split(';')[0].trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(text)) return null
  return text.slice(0, 100)
}

function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return []
  const links = []
  for (const entry of value) {
    if (links.length >= 100) break
    if (!entry || typeof entry !== 'object') continue
    const url = sanitizeFinalUrl(entry.url)
    if (!url) continue
    const text = sanitizeControl(entry.text, 200)
    if (!text) continue
    links.push({ text, url })
  }
  return links
}

function normalizeScripts(value, mode) {
  if (mode !== 'js') return undefined
  if (!value || typeof value !== 'object') {
    return { external: [], inline: [], dynamic: { detected: false, signals: [] } }
  }
  const external = Array.isArray(value.external)
    ? value.external.slice(0, 100).flatMap((entry) => {
      const src = sanitizeFinalUrl(entry?.src)
      if (!src) return []
      return [{
        src,
        type: typeof entry?.type === 'string' ? sanitizeControl(entry.type, 80) || null : null,
        async: entry?.async === true,
        defer: entry?.defer === true,
        module: entry?.module === true,
      }]
    })
    : []
  const inline = Array.isArray(value.inline)
    ? value.inline.slice(0, 30).flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return []
      const flags = Array.isArray(entry.flags)
        ? entry.flags.filter((flag) => typeof flag === 'string').slice(0, 12).map((flag) => flag.slice(0, 40))
        : []
      return [{
        index: Number.isInteger(entry.index) ? entry.index : index,
        chars: Number.isInteger(entry.chars) ? Math.max(0, entry.chars) : 0,
        type: sanitizeControl(entry.type || 'text/javascript', 80),
        flags,
      }]
    })
    : []
  const dynamic = value.dynamic && typeof value.dynamic === 'object' ? value.dynamic : {}
  return {
    external_count: Number.isInteger(value.external_count) ? Math.max(0, value.external_count) : external.length,
    inline_count: Number.isInteger(value.inline_count) ? Math.max(0, value.inline_count) : inline.length,
    external,
    inline,
    dynamic: {
      detected: dynamic.detected === true,
      signals: Array.isArray(dynamic.signals)
        ? dynamic.signals.filter((signal) => typeof signal === 'string').slice(0, 20).map((signal) => signal.slice(0, 60))
        : [],
      dom_mutations: Number.isInteger(dynamic.dom_mutations) ? Math.max(0, dynamic.dom_mutations) : 0,
      post_load_resources: Number.isInteger(dynamic.post_load_resources) ? Math.max(0, dynamic.post_load_resources) : 0,
    },
  }
}

function errorStatus(error) {
  if (error instanceof WebReadError) return error
  if (error instanceof PolicyError) return new WebReadError(error.code, error.message, error.status)
  return new WebReadError('INTERNAL_ERROR', '网页读取进程发生内部错误。', 'internal_error')
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new WebReadError('TIMEOUT', '页面读取超时。', 'timeout'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new WebReadError('TIMEOUT', '页面读取超时。', 'timeout'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function removeWithRetries(directory) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 2 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100))
    }
  }
}

async function runRead(request, controller) {
  const deadline = Date.now() + clampInt(request.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 10000)
  const maxBytes = clampInt(request.max_bytes, MIN_BYTES, MAX_BYTES, 200000)
  const mode = ALLOWED_MODES.has(request.mode) ? request.mode : 'text'
  const waitFor = typeof request.wait_for === 'string' ? request.wait_for.trim().slice(0, 256) : ''
  const includeLinks = request.include_links === true
  const allowedPorts = normalizePorts(request.allowedPorts)
  const proxyOptions = {
    allowedDomains: normalizeStringList(request.allowedDomains),
    deniedDomains: normalizeStringList(request.deniedDomains),
    allowedPorts,
    maxBytes,
    deadline,
  }

  // 形状校验在启动任何进程前完成。
  validateUrlShape(request.url, { allowedPorts })
  let workDir = null
  let proxy = null
  let browser = null
  let base = null

  try {
    proxy = await startGuardProxy(proxyOptions)
    await abortable(proxy.guard.checkUrl(request.url, deadline), controller.signal)

    workDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-read-'))
    browser = await abortable(launchBrowser({
      browser: request.browser,
      proxyPort: proxy.port,
      deadline,
      maxBytes,
      workDir,
    }), controller.signal)

    await abortable(browser.navigate(request.url, {
      mode,
      waitFor,
      deadline,
    }), controller.signal)

    const page = await abortable(browser.extract({
      mode: mode === 'html' ? 'html' : 'text',
      maxChars: maxBytes,
      includeLinks,
      withScripts: mode === 'js',
    }), controller.signal)

    const finalUrl = sanitizeFinalUrl(page.url || browser.state.finalUrl)
    if (!finalUrl) {
      throw new WebReadError('UNSUPPORTED_REDIRECT', '页面最终地址不是可读取的 http/https 地址。', 'blocked')
    }
    const mime = sanitizeMime(page.contentType || browser.state.mainMime)
    const statusCode = browser.state.mainStatus

    if (browser.state.mainBlocked) {
      throw new WebReadError('URL_BLOCKED', '目标地址被网络策略拦截。', 'blocked')
    }
    if (mime && (
      mime.startsWith('image/') ||
      mime.startsWith('audio/') ||
      mime.startsWith('video/') ||
      mime.startsWith('font/') ||
      mime === 'application/pdf' ||
      mime === 'application/zip' ||
      mime === 'application/x-zip-compressed' ||
      mime === 'application/octet-stream'
    )) {
      throw new WebReadError('UNSUPPORTED_CONTENT_TYPE', `不支持读取该内容类型（${mime}）。`, 'parse_error')
    }

    const rawContent = mode === 'html' ? String(page.html || '') : String(page.text || '')
    const contentResult = truncateUtf8(rawContent, maxBytes)
    const truncated = page.truncated === true || contentResult.truncated || proxy.stats.truncated || browser.state.truncated || proxy.stats.exhausted
    const title = sanitizeControl(page.title || '', 300) || null
    const scripts = normalizeScripts(page.scripts, mode)
    const links = includeLinks ? normalizeLinks(page.links) : undefined

    base = {
      status: 'ok',
      url_final: finalUrl,
      title,
      content: contentResult.text,
      content_type: mime,
      truncated,
    }
    if (links) base.links = links
    if (scripts) base.scripts = scripts
    if (statusCode !== null && statusCode >= 400) {
      base.status = 'http_error'
      base.error = { code: 'HTTP_STATUS', message: `目标站点返回 HTTP ${statusCode}。` }
    }
    return base
  } catch (error) {
    let finalError = errorStatus(error)
    if (proxy && proxy.stats.blockedRequests.some((entry) => String(entry.code).includes('SSRF') || String(entry.code).includes('DOMAIN') || String(entry.code).includes('PORT') || String(entry.code).includes('PROTOCOL'))) {
      if (finalError.status === 'network_error' || finalError.status === 'blocked' || finalError.code === 'NETWORK_ERROR') {
        finalError = new WebReadError('URL_BLOCKED', '目标地址被安全策略拦截。', 'blocked')
      }
    }
    if ((Date.now() >= deadline || controller.signal.aborted) &&
        finalError.code !== 'URL_BLOCKED' &&
        finalError.code !== 'SSRF_BLOCKED' &&
        finalError.code !== 'DOMAIN_BLOCKED' &&
        finalError.code !== 'DOMAIN_NOT_ALLOWED' &&
        finalError.code !== 'PORT_BLOCKED') {
      finalError = new WebReadError('TIMEOUT', '网页读取超时。', 'timeout')
    }
    const publicError = toPublicError(finalError)
    const result = emptyResult(publicError.status, publicError.code, publicError.message)
    if (includeLinks) result.links = []
    if (mode === 'js') result.scripts = { external: [], inline: [], dynamic: { detected: false, signals: [] } }
    if (proxy?.stats.truncated || browser?.state.truncated) result.truncated = true
    const partialUrl = sanitizeFinalUrl(browser?.state.finalUrl)
    if (partialUrl) result.url_final = partialUrl
    // 若已经完成页面提取而只是 HTTP 状态/内容类型错误，保留可读的部分上下文。
    if (base) {
      result.url_final = base.url_final
      result.title = base.title
      result.content_type = base.content_type
    }
    return result
  } finally {
    try {
      await browser?.close()
    } catch {
      /* ignore */
    }
    try {
      await proxy?.close()
    } catch {
      /* ignore */
    }
    if (workDir) await removeWithRetries(workDir)
  }
}

function handleRequest(request) {
  activeController = new AbortController()
  const timeoutMs = clampInt(request.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 10000)
  const timer = setTimeout(() => {
    activeController.abort(new WebReadError('TIMEOUT', '网页读取超时。', 'timeout'))
  }, timeoutMs)
  timer.unref?.()

  runRead(request, activeController).then((result) => {
    clearTimeout(timer)
    writeResult(result)
  }).catch((error) => {
    clearTimeout(timer)
    const publicError = toPublicError(errorStatus(error))
    writeResult(emptyResult(publicError.status, publicError.code, publicError.message))
  })
}

let input = ''
let started = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (input.length > MAX_REQUEST_BYTES) {
    writeResult(emptyResult('invalid_request', 'REQUEST_TOO_LARGE', '读取请求过大。'))
    process.exit(0)
  }
  let index = input.indexOf('\n')
  while (index >= 0) {
    const line = input.slice(0, index).trim()
    input = input.slice(index + 1)
    index = input.indexOf('\n')
    if (!line) continue
    if (!started) {
      started = true
      let request
      try {
        request = JSON.parse(line)
      } catch {
        writeResult(emptyResult('invalid_request', 'INVALID_REQUEST', '读取请求不是合法 JSON。'))
        process.exit(0)
        return
      }
      if (!request || typeof request !== 'object' || request.type !== 'read') {
        writeResult(emptyResult('invalid_request', 'INVALID_REQUEST', '读取请求类型无效。'))
        process.exit(0)
        return
      }
      handleRequest(request)
    } else {
      try {
        const message = JSON.parse(line)
        if (message?.type === 'cancel' && activeController && !activeController.signal.aborted) {
          activeController.abort(new WebReadError('CANCELLED', '读取已取消。', 'timeout'))
        }
      } catch {
        /* ignore malformed control line */
      }
    }
  }
})

process.stdin.on('end', () => {
  if (!started) process.exit(0)
})

process.on('uncaughtException', (error) => {
  const publicError = toPublicError(errorStatus(error))
  writeResult(emptyResult(publicError.status, publicError.code, publicError.message))
})
process.on('unhandledRejection', (error) => {
  const publicError = toPublicError(errorStatus(error))
  writeResult(emptyResult(publicError.status, publicError.code, publicError.message))
})
