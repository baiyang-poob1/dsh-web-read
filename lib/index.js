/**
 * dsh-web-read / lib/index.js
 *
 * Host 侧只做四件事：
 *   1. 把 web_read 的 Tool Schema 暴露给模型（模型看不到 worker 内部）；
 *   2. 校验/裁剪模型参数，并施加进程并发上限；
 *   3. 启动独立 worker，通过 stdin/stdout 传递一次读取请求；
 *   4. 把 worker 结果再次收敛为固定 JSON 形状，不让任何额外字段外泄。
 *
 * 网络访问、SSRF 防护、浏览器渲染、正文提取全部发生在 worker/ 内；
 * Host 进程本身不解析页面、不访问目标 URL。
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const WORKER_ENTRY = path.join(PACKAGE_ROOT, 'worker', 'main.mjs')
const INPUT_SCHEMA = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'schema', 'web_read.input.json'), 'utf8'))
const OUTPUT_SCHEMA = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'schema', 'web_read.output.json'), 'utf8'))

const TOOL_NAME = 'web_read'
const WORKER_RESULT_LIMIT = 4 * 1024 * 1024
const ALLOWED_STATUS = new Set([
  'ok', 'blocked', 'timeout', 'too_large', 'http_error', 'network_error',
  'parse_error', 'invalid_request', 'browser_error', 'internal_error',
])

const DEFAULT_CONFIG = Object.freeze({
  allowedDomains: [],
  deniedDomains: [],
  allowedPorts: [80, 443],
  maxConcurrency: 2,
  browser: 'auto',
})

function normalizedConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const allowedDomains = Array.isArray(raw.allowedDomains)
    ? raw.allowedDomains.filter((item) => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 253))
    : []
  const deniedDomains = Array.isArray(raw.deniedDomains)
    ? raw.deniedDomains.filter((item) => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 253))
    : []
  const allowedPorts = Array.isArray(raw.allowedPorts)
    ? raw.allowedPorts.map(Number).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535).slice(0, 10)
    : []
  const maxConcurrency = Number.isInteger(raw.maxConcurrency)
    ? Math.min(4, Math.max(1, raw.maxConcurrency))
    : DEFAULT_CONFIG.maxConcurrency
  const browser = raw.browser === 'edge' || raw.browser === 'chrome' ? raw.browser : 'auto'
  return {
    allowedDomains,
    deniedDomains,
    allowedPorts: allowedPorts.length > 0 ? allowedPorts : DEFAULT_CONFIG.allowedPorts,
    maxConcurrency,
    browser,
  }
}

function workerPath() {
  return WORKER_ENTRY
}

function workerEnvironment() {
  const allow = [
    'SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LANG', 'LC_ALL', 'DISPLAY',
  ]
  const env = {}
  for (const key of allow) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

function emptyScripts() {
  return { external: [], inline: [], dynamic: { detected: false, signals: [] } }
}

function errorResult(status, code, message, args = {}) {
  const result = {
    status,
    url_final: null,
    title: null,
    content: null,
    content_type: null,
    truncated: false,
    error: { code, message },
  }
  if (args.includeLinks === true) result.links = []
  if (args.mode === 'js') result.scripts = emptyScripts()
  return result
}

function safeString(value, maxChars) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (!cleaned) return null
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned
}

function validateArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: errorResult('invalid_request', 'INVALID_ARGUMENTS', '参数必须是一个对象。') }
  }
  if (typeof raw.url !== 'string' || raw.url.trim().length === 0 || raw.url.trim().length > 4096) {
    return { error: errorResult('invalid_request', 'INVALID_URL', 'url 必须是 1 到 4096 字符的字符串。') }
  }
  let parsed
  try {
    parsed = new URL(raw.url.trim())
  } catch {
    return { error: errorResult('invalid_request', 'INVALID_URL', 'url 不是合法的绝对地址。') }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: errorResult('blocked', 'UNSUPPORTED_PROTOCOL', '只允许 http 或 https 协议。') }
  }
  if (parsed.username || parsed.password) {
    return { error: errorResult('blocked', 'URL_CREDENTIALS', 'url 不能包含用户名或密码。') }
  }
  const mode = raw.mode === undefined ? 'text' : raw.mode
  if (mode !== 'text' && mode !== 'html' && mode !== 'js') {
    return { error: errorResult('invalid_request', 'INVALID_MODE', 'mode 只能是 text、html 或 js。') }
  }
  if (raw.wait_for !== undefined && (typeof raw.wait_for !== 'string' || raw.wait_for.length > 256)) {
    return { error: errorResult('invalid_request', 'INVALID_WAIT_FOR', 'wait_for 必须是不超过 256 字符的字符串。') }
  }
  if (raw.timeout_ms !== undefined) {
    if (!Number.isInteger(raw.timeout_ms) || raw.timeout_ms < 1000 || raw.timeout_ms > 30000) {
      return { error: errorResult('invalid_request', 'INVALID_TIMEOUT', 'timeout_ms 必须是 1000 到 30000 的整数。') }
    }
  }
  if (raw.max_bytes !== undefined) {
    if (!Number.isInteger(raw.max_bytes) || raw.max_bytes < 1000 || raw.max_bytes > 1000000) {
      return { error: errorResult('invalid_request', 'INVALID_MAX_BYTES', 'max_bytes 必须是 1000 到 1000000 的整数。') }
    }
  }
  if (raw.include_links !== undefined && typeof raw.include_links !== 'boolean') {
    return { error: errorResult('invalid_request', 'INVALID_INCLUDE_LINKS', 'include_links 必须是布尔值。') }
  }
  return {
    args: {
      url: parsed.href,
      mode,
      waitFor: typeof raw.wait_for === 'string' ? raw.wait_for.trim() : '',
      timeoutMs: raw.timeout_ms ?? 10000,
      maxBytes: raw.max_bytes ?? 200000,
      includeLinks: raw.include_links === true,
    },
  }
}

function sanitizeLinks(value, maxBytes) {
  if (!Array.isArray(value)) return []
  const links = []
  let budget = Math.min(maxBytes, 20000)
  for (const entry of value) {
    if (links.length >= 100 || budget <= 0) break
    if (!entry || typeof entry !== 'object') continue
    let url
    try {
      const parsed = new URL(String(entry.url ?? ''))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      if (parsed.username || parsed.password) continue
      url = parsed.href.slice(0, 2048)
    } catch {
      continue
    }
    const text = safeString(entry.text, 200)
    if (!text) continue
    const cost = Buffer.byteLength(text) + Buffer.byteLength(url)
    if (cost > budget) break
    budget -= cost
    links.push({ text, url })
  }
  return links
}

function sanitizeScripts(value) {
  if (!value || typeof value !== 'object') return emptyScripts()
  const external = Array.isArray(value.external)
    ? value.external.slice(0, 100).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      let src
      try {
        const parsed = new URL(String(entry.src ?? ''))
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return []
        if (parsed.username || parsed.password) return []
        src = parsed.href.slice(0, 2048)
      } catch {
        return []
      }
      return [{
        src,
        type: safeString(entry.type, 80),
        async: entry.async === true,
        defer: entry.defer === true,
        module: entry.module === true,
      }]
    })
    : []
  const inline = Array.isArray(value.inline)
    ? value.inline.slice(0, 30).flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return []
      return [{
        index: Number.isInteger(entry.index) ? entry.index : index,
        chars: Number.isInteger(entry.chars) ? Math.max(0, entry.chars) : 0,
        type: safeString(entry.type, 80) || 'text/javascript',
        flags: Array.isArray(entry.flags)
          ? entry.flags.filter((flag) => typeof flag === 'string').slice(0, 12).map((flag) => flag.slice(0, 40))
          : [],
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

function sanitizeWorkerResult(raw, args) {
  if (!raw || typeof raw !== 'object') {
    return errorResult('internal_error', 'WORKER_RESULT_INVALID', '网页读取进程返回了无效结果。', args)
  }
  const status = ALLOWED_STATUS.has(raw.status) ? raw.status : 'internal_error'
  let content = typeof raw.content === 'string' ? raw.content : null
  let truncated = raw.truncated === true
  if (content !== null) {
    const cut = truncateUtf8(content, args.maxBytes)
    content = cut.text
    if (cut.truncated) truncated = true
  }
  let urlFinal = null
  if (typeof raw.url_final === 'string') {
    try {
      const parsed = new URL(raw.url_final)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
        urlFinal = parsed.href.slice(0, 4096)
      }
    } catch {
      urlFinal = null
    }
  }
  const result = {
    status,
    url_final: urlFinal,
    title: safeString(raw.title, 300),
    content,
    content_type: safeString(raw.content_type, 100),
    truncated,
  }
  if (args.includeLinks) result.links = sanitizeLinks(raw.links, args.maxBytes)
  if (args.mode === 'js') result.scripts = sanitizeScripts(raw.scripts)
  if (status !== 'ok') {
    const code = safeString(raw.error?.code, 80) || 'WORKER_ERROR'
    const message = safeString(raw.error?.message, 500) || '网页读取失败。'
    result.error = { code, message }
  }
  return result
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      })
      killer.unref()
      return
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

export function workerHardStopMs(request) {
  const requested = Number.isInteger(request?.timeout_ms)
    ? Math.min(30000, Math.max(1000, request.timeout_ms))
    : 10000
  return requested + 4000
}

async function runWorker(request, signal) {
  const execPath = process.execPath
  const worker = spawn(execPath, [workerPath()], {
    cwd: os.tmpdir(),
    env: workerEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const stdout = []
  let stdoutBytes = 0
  let settled = false
  let hardStopTimer = null
  let killTimer = null
  let onAbort = null

  const cleanup = () => {
    if (hardStopTimer) clearTimeout(hardStopTimer)
    if (killTimer) clearTimeout(killTimer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }

  const stopGracefully = () => {
    if (settled) return
    try {
      worker.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`)
    } catch {
      /* ignore */
    }
    if (!killTimer) {
      killTimer = setTimeout(() => killTree(worker), 1500)
      killTimer.unref?.()
    }
  }

  // The worker request uses snake_case (`timeout_ms`) because it is also the
  // external protocol shape. Keep this normalization aligned with
  // worker/main.mjs. Do not read `request.timeoutMs` here: it is undefined, and
  // `undefined + 4000` becomes NaN, which makes setTimeout fire immediately and
  // cancel every worker before it can start.
  hardStopTimer = setTimeout(stopGracefully, workerHardStopMs(request))
  hardStopTimer.unref?.()
  if (signal) {
    if (signal.aborted) stopGracefully()
    else {
      onAbort = stopGracefully
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return await new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        worker.stdin.end()
      } catch {
        /* ignore */
      }
      resolve(value)
    }

    worker.on('error', () => {
      finish({ __error: true, status: 'browser_error', code: 'WORKER_START_FAILED', message: '无法启动网页读取进程。' })
    })
    worker.stdout.on('error', () => {
      finish({ __error: true, status: 'internal_error', code: 'WORKER_IO_FAILED', message: '网页读取进程的输出通道失败。' })
    })
    worker.stderr.on('error', () => {
      /* stderr 只用于丢弃诊断 */
    })
    worker.stdout.setEncoding('utf8')
    worker.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > WORKER_RESULT_LIMIT) {
        stopGracefully()
        killTree(worker)
        finish({ __error: true, status: 'too_large', code: 'RESULT_TOO_LARGE', message: '网页读取结果超过大小上限。' })
        return
      }
      stdout.push(chunk)
    })
    worker.stderr.on('data', () => {
      /* 不把浏览器/worker stderr 回传给模型；其中可能包含目标页面数据。 */
    })
    worker.stdin.on('error', () => {
      /* close/abort 时 EPIPE 是正常竞态 */
    })

    worker.on('close', (code, signalName) => {
      if (settled) return
      const text = stdout.join('').trim()
      let result = null
      if (text) {
        const lines = text.split(/\r?\n/).filter(Boolean)
        try {
          result = JSON.parse(lines[lines.length - 1])
        } catch {
          result = null
        }
      }
      if (!result) {
        const aborted = signal?.aborted === true
        finish(aborted
          ? { __error: true, status: 'timeout', code: 'CANCELLED', message: '网页读取已取消。' }
          : { __error: true, status: 'internal_error', code: 'WORKER_FAILED', message: `网页读取进程异常退出（${code ?? signalName ?? 'unknown'}）。` })
        return
      }
      finish(result)
    })

    try {
      worker.stdin.write(`${JSON.stringify(request)}\n`)
    } catch {
      finish({ __error: true, status: 'internal_error', code: 'WORKER_WRITE_FAILED', message: '无法向网页读取进程发送请求。' })
    }
  })
}

function createSemaphore(limit) {
  let active = 0
  const waiters = []

  const grant = (waiter) => {
    active += 1
    let released = false
    waiter.cleanup?.()
    waiter.resolve(() => {
      if (released) return
      released = true
      active -= 1
      while (active < limit && waiters.length > 0) {
        const next = waiters.shift()
        grant(next)
      }
    })
  }

  const acquire = (signal) => new Promise((resolve, reject) => {
    if (!signal || !signal.aborted) {
      if (active < limit) {
        grant({ resolve, cleanup: () => {} })
        return
      }
    }
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
      return
    }
    const waiter = { resolve, reject, cleanup: null }
    const onAbort = () => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
    }
    waiter.cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    waiters.push(waiter)
  })

  return { acquire }
}

function toolDescription() {
  return [
    '阅读一个公网网页，返回结构化正文。',
    'mode=text：静态正文（不执行页面 JS）；mode=html：精简后的 HTML；mode=js：执行页面 JS 后提取正文，并返回脚本来源和动态加载信号。',
    'wait_for 可等待异步渲染的 CSS 选择器。',
    '仅支持公网 http/https；默认只允许 80/443 端口。内网、回环、云元数据地址与超大响应会被拒绝或截断。',
    'status 不是 ok 时查看 error.code；truncated=true 表示内容已截断。',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const settings = normalizedConfig(config)
  const semaphore = createSemaphore(settings.maxConcurrency)

  const executeRead = async (rawArgs, exec) => {
    const valid = validateArgs(rawArgs)
    if (valid.error) return valid.error
    const args = valid.args

    let release
    try {
      release = await semaphore.acquire(exec?.signal)
    } catch {
      return errorResult('timeout', 'CANCELLED', '网页读取已取消。', args)
    }

    try {
      const request = {
        type: 'read',
        url: args.url,
        mode: args.mode,
        wait_for: args.waitFor,
        timeout_ms: args.timeoutMs,
        max_bytes: args.maxBytes,
        include_links: args.includeLinks,
        allowedDomains: settings.allowedDomains,
        deniedDomains: settings.deniedDomains,
        allowedPorts: settings.allowedPorts,
        browser: settings.browser,
      }
      const raw = await runWorker(request, exec?.signal)
      if (raw.__error) {
        return errorResult(raw.status || 'internal_error', raw.code || 'WORKER_FAILED', raw.message || '网页读取失败。', args)
      }
      return sanitizeWorkerResult(raw, args)
    } catch {
      return errorResult('internal_error', 'WORKER_FAILED', '网页读取进程异常结束。', args)
    } finally {
      release?.()
    }
  }

  const tool = {
    name: TOOL_NAME,
    description: toolDescription(),
    parameters: INPUT_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }],
    },
    timeoutMs: 35000,
    isConcurrencySafe: () => false,
    presentCall: (args) => {
      let host = ''
      try {
        host = new URL(String(args?.url ?? '')).host
      } catch {
        host = String(args?.url ?? '').slice(0, 120)
      }
      const mode = typeof args?.mode === 'string' ? args.mode : 'text'
      return {
        card: 'generic',
        kind: 'fetch',
        title: `读取 ${host || '网页'}（${mode}）`,
        rawInput: { url: args?.url, mode },
      }
    },
    execute: executeRead,
  }

  ctx.effect(() => ctx.tools.register(tool))
}

export const inject = ['tools']
export const name = 'tool-web-read'
