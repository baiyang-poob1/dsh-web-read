/**
 * dsh-web-read / worker/browser.mjs
 *
 * 在独立 worker 进程内启动一个临时 Edge/Chrome，经本地 Guard Proxy 访问网络。
 * 浏览器使用临时 profile、禁用下载/弹窗/权限提示/WebRTC/QUIC，并在关闭时清理。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CdpConnection, CdpError } from './cdp.mjs'
import { WebReadError } from './errors.mjs'
import { extractInPage } from './extract.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const PROBE_SCRIPT = `(() => {
  try {
    const probe = { domMutations: 0, dclAt: 0 };
    try {
      Object.defineProperty(window, '__dshWebReadProbe', { value: probe, enumerable: false, configurable: false });
    } catch {
      window.__dshWebReadProbe = probe;
    }
    try {
      new MutationObserver((records) => {
        if (probe.dclAt > 0) probe.domMutations += records.length;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    } catch {}
    document.addEventListener('DOMContentLoaded', () => {
      probe.dclAt = performance.now();
      probe.domMutations = 0;
    }, { once: true });
  } catch {}
})();`

function sanitizedBrowserEnv(tempDir) {
  const care = [
    'SystemRoot', 'WINDIR', 'PATH', 'USERPROFILE', 'LOCALAPPDATA',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP',
    'LANG', 'LC_ALL', 'DISPLAY',
  ]
  const env = {}
  for (const key of care) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  env.TEMP = tempDir
  env.TMP = tempDir
  return env
}

export function discoverBrowser(kind = 'auto') {
  const home = os.homedir()
  const winEdge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  const winChrome = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  const winChromium = [
    path.join(home, 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'),
  ]
  const macChrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  const macEdge = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  const linuxChrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
  const linuxChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']

  const groups = {
    edge: [...winEdge, ...macEdge],
    chrome: [...winChrome, ...macChrome],
    chromium: [...winChromium, ...linuxChromium],
    linux: [...linuxChrome, ...linuxChromium],
  }
  const ordered = kind === 'edge'
    ? groups.edge
    : kind === 'chrome'
      ? [...groups.chrome, ...groups.chromium, ...groups.linux]
      : [...groups.edge, ...groups.chrome, ...groups.chromium, ...groups.linux]

  for (const candidate of ordered) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

function browserArgs(proxyPort, profileDir) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-extensions',
    '--disable-client-side-phishing-detection',
    '--disable-notifications',
    '--disable-geolocation',
    '--disable-permissions-api',
    '--deny-permission-prompts',
    '--disable-prompt-on-repost',
    '--disable-dev-shm-usage',
    '--disable-quic',
    '--dns-prefetch-disable',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--metrics-recording-only',
    '--no-pings',
    '--safebrowsing-disable-auto-update',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--hide-scrollbars',
    '--autoplay-policy=user-gesture-required',
    '--renderer-process-limit=2',
    '--js-flags=--max-old-space-size=512',
    '--window-size=1280,900',
    '--force-device-scale-factor=1',
    '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,AutofillServerCommunication,PrivacySandboxSettings4',
    '--disable-third-party-cookies',
    '--test-third-party-cookie-phaseout',
    'about:blank',
  ]
}

async function waitForDevTools(profileDir, deadline, browser) {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  let lastError = null
  while (Date.now() < deadline) {
    if (browser.exitCode !== null) {
      throw new WebReadError('BROWSER_START_FAILED', '无头浏览器在启动阶段退出。', 'browser_error')
    }
    try {
      const text = await readFile(portFile, 'utf8')
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const port = Number(lines[0])
      const wsPath = lines[1] || '/'
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { port, wsPath }
      }
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new WebReadError('BROWSER_START_TIMEOUT', '无头浏览器启动超时。', 'browser_error')
}

async function connectWithRetry(wsUrl, deadline, browser) {
  let lastError = null
  while (Date.now() < deadline) {
    if (browser.exitCode !== null) break
    try {
      return await CdpConnection.connect(wsUrl, {
        timeoutMs: Math.min(3000, Math.max(500, deadline - Date.now())),
        defaultTimeoutMs: 10000,
      })
    } catch (error) {
      lastError = error
      await sleep(150)
    }
  }
  const code = lastError instanceof CdpError && lastError.code === 'CDP_CONNECT_TIMEOUT'
    ? 'BROWSER_START_TIMEOUT'
    : 'BROWSER_CDP_FAILED'
  throw new WebReadError(code, '无法连接无头浏览器的 DevTools 端点。', 'browser_error')
}

function navigationError(errorText) {
  const text = String(errorText || '')
  if (!text) return new WebReadError('NAVIGATION_FAILED', '页面导航失败。', 'network_error')
  if (text.includes('ERR_BLOCKED_BY_CLIENT') || text.includes('ERR_BLOCKED_BY_RESPONSE')) {
    return new WebReadError('URL_BLOCKED', '目标地址被浏览器安全策略拦截。', 'blocked')
  }
  if (text.includes('ERR_NAME_NOT_RESOLVED') || text.includes('ERR_NAME_RESOLUTION_FAILED')) {
    return new WebReadError('DNS_FAILED', '目标域名无法解析。', 'network_error')
  }
  if (text.includes('ERR_CONNECTION_TIMED_OUT') || text.includes('ERR_TIMED_OUT')) {
    return new WebReadError('TIMEOUT', '页面加载超时。', 'timeout')
  }
  if (text.includes('ERR_ABORTED') || text.includes('ERR_BLOCKED_BY_CLIENT')) {
    return new WebReadError('REQUEST_ABORTED', '页面加载被中止。', 'network_error')
  }
  if (text.includes('ERR_UNSAFE_PORT') || text.includes('ERR_UNSAFE_REDIRECT')) {
    return new WebReadError('URL_BLOCKED', '目标端口或重定向被安全策略拒绝。', 'blocked')
  }
  return new WebReadError('NETWORK_ERROR', '页面网络请求失败。', 'network_error')
}

function safeStatusCode(value) {
  const code = Number(value)
  return Number.isInteger(code) && code >= 0 && code <= 599 ? code : null
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return ' '
      }
    })
    .replace(/&#(\d+);/g, (_match, decimal) => {
      try {
        return String.fromCodePoint(Number(decimal))
      } catch {
        return ' '
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function visibleSourceText(rawHtml) {
  const withoutCode = String(rawHtml ?? '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
  return decodeEntities(withoutCode.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function contentNotInSource(renderedText, rawHtml) {
  const source = visibleSourceText(rawHtml)
  const rendered = String(renderedText ?? '').replace(/\s+/g, ' ').trim()
  if (source.length < 80 || rendered.length < 80) return false
  const length = Math.min(90, Math.floor(rendered.length / 2))
  if (length < 30) return false
  const marks = [0, 0.25, 0.5, 0.75]
    .map((ratio) => Math.floor((rendered.length - length) * ratio))
    .filter((value, index, array) => array.indexOf(value) === index)
  return marks.some((start) => {
    const sample = rendered.slice(start, start + length).trim()
    return sample.length >= 30 && !source.includes(sample)
  })
}

export async function launchBrowser(options = {}) {
  const browserKind = typeof options.browser === 'string' ? options.browser : 'auto'
  const proxyPort = Number(options.proxyPort)
  const deadline = Number(options.deadline) || (Date.now() + 10000)
  const maxBytes = Math.min(1_000_000, Math.max(1000, Number(options.maxBytes) || 200000))
  const maxEntryBytes = Math.min(8_000_000, Math.max(2_000_000, maxBytes * 4))
  const workDir = options.workDir
  if (!workDir) throw new WebReadError('INTERNAL_ERROR', '缺少临时工作目录。', 'internal_error')

  const executable = discoverBrowser(browserKind)
  if (!executable) {
    throw new WebReadError('BROWSER_UNAVAILABLE', '未找到 Edge/Chrome 无头浏览器。', 'browser_error')
  }

  const profileDir = path.join(workDir, 'profile')
  const logPath = path.join(workDir, 'browser.log')
  const logFd = openSync(logPath, 'a')
  let logOpen = true
  let browser
  try {
    browser = spawn(executable, browserArgs(proxyPort, profileDir), {
      cwd: workDir,
      env: sanitizedBrowserEnv(workDir),
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    })
    browser.on('error', () => {})
  } finally {
    // 子进程已继承句柄；父进程不再需要它。
    if (logOpen) {
      closeSync(logFd)
      logOpen = false
    }
  }

  let cdp
  let sessionId
  let targetId
  let closed = false
  try {
    const devtoolsDeadline = Math.min(deadline, Date.now() + 10000)
    const { port, wsPath } = await waitForDevTools(profileDir, devtoolsDeadline, browser)
    const cleanPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
    cdp = await connectWithRetry(`ws://127.0.0.1:${port}${cleanPath}`, devtoolsDeadline, browser)

    const create = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: false, background: false }, undefined, 5000)
    targetId = create.targetId
    if (!targetId) throw new WebReadError('BROWSER_CDP_FAILED', '浏览器未创建页面目标。', 'browser_error')
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 5000)
    sessionId = attached.sessionId
    if (!sessionId) throw new WebReadError('BROWSER_CDP_FAILED', '浏览器未附着页面目标。', 'browser_error')

    const state = {
      mainRequestId: null,
      mainStatus: null,
      mainMime: null,
      mainBlocked: false,
      navError: null,
      finalUrl: null,
      mainFrameId: null,
      requests: 0,
      xhr: 0,
      fetch: 0,
      decodedBytes: 0,
      maxEntryBytes: 0,
      truncated: false,
      windowOpenBlocked: false,
      downloadBlocked: false,
      inflight: new Set(),
    }

    cdp.onEvent((method, params, eventSession) => {
      if (method === 'Network.requestWillBeSent') {
        state.requests += 1
        state.inflight.add(params.requestId)
        if (params.type === 'Document' && !state.mainRequestId) state.mainRequestId = params.requestId
        if (params.type === 'XHR') state.xhr += 1
        if (params.type === 'Fetch') state.fetch += 1
        if (params.redirectResponse && params.requestId === state.mainRequestId) {
          const redirect = params.redirectResponse
          state.mainStatus = safeStatusCode(redirect.status)
          state.mainMime = redirect.mimeType || state.mainMime
        }
      } else if (method === 'Network.responseReceived') {
        if (params.requestId === state.mainRequestId) {
          state.mainStatus = safeStatusCode(params.response?.status)
          state.mainMime = params.response?.mimeType || state.mainMime
          const headers = params.response?.headers || {}
          if (headers['x-dsh-web-read-blocked'] === '1' || headers['X-Dsh-Web-Read-Blocked'] === '1') {
            state.mainBlocked = true
          }
        }
      } else if (method === 'Network.loadingFinished') {
        state.inflight.delete(params.requestId)
        const size = Number(params.encodedDataLength) || 0
        state.decodedBytes += size
        if (size > state.maxEntryBytes) state.maxEntryBytes = size
        if (size > maxEntryBytes) state.truncated = true
      } else if (method === 'Network.loadingFailed') {
        state.inflight.delete(params.requestId)
        if (params.requestId === state.mainRequestId) state.navError = params.errorText || 'NETWORK_ERROR'
      } else if (method === 'Page.frameNavigated') {
        if (params.frame && !params.frame.parentId) {
          state.mainFrameId = params.frame.id
          state.finalUrl = params.frame.url
        }
      } else if (method === 'Target.targetCreated') {
        const info = params.targetInfo
        if (info && info.type === 'page' && info.targetId !== targetId) {
          state.windowOpenBlocked = true
          cdp.send('Target.closeTarget', { targetId: info.targetId }, undefined, 1000).catch(() => {})
        }
      } else if (method === 'Page.windowOpen') {
        state.windowOpenBlocked = true
      } else if (method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: false }, eventSession || sessionId, 1000).catch(() => {})
      } else if (method === 'Fetch.requestPaused') {
        // 尝试在 DevTools 层再剥一次 Cookie/认证头。注意：浏览器网络栈
        // 可能在拦截之后重新附加同源 Cookie，所以正式边界仍是“不注入宿主
        // 凭据、不返回 cookie/headers”，而不是把这里当作 cookie 隔离的唯一保证。
        const blockedHeaders = new Set(['cookie', 'cookie2', 'authorization', 'proxy-authorization'])
        const headers = Object.entries(params.request?.headers || {})
          .filter(([name]) => !blockedHeaders.has(String(name).toLowerCase()))
          .map(([name, value]) => ({ name: String(name), value: String(value) }))
        cdp.send('Fetch.continueRequest', { requestId: params.requestId, headers }, eventSession || sessionId, 5000).catch(() => {})
      } else if (method === 'Fetch.authRequired') {
        cdp.send('Fetch.continueWithAuth', {
          requestId: params.requestId,
          authChallengeResponse: { response: 'CancelAuth' },
        }, eventSession || sessionId, 3000).catch(() => {})
      } else if (method === 'Page.downloadWillBegin') {
        state.downloadBlocked = true
        cdp.send('Browser.cancelDownload', { guid: params.guid }, undefined, 1000).catch(() => {})
      }
    })

    await cdp.send('Page.enable', {}, sessionId, 5000)
    await cdp.send('Runtime.enable', {}, sessionId, 5000)
    await cdp.send('Network.enable', {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 5_000_000,
      maxPostDataSize: 1024,
    }, sessionId, 5000)
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId, 5000)
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId, 5000)
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    }, sessionId, 5000)
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId, 5000)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId, 5000)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SCRIPT }, sessionId, 5000)
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }, undefined, 3000)
    } catch {
      /* 老版本没有 Browser 域；Page.downloadWillBegin 仍会阻止交互 */
    }
    try {
      await cdp.send('Target.setDiscoverTargets', { discover: true }, undefined, 3000)
    } catch {
      /* 不影响单页读取 */
    }

    const remaining = () => deadline - Date.now()

    const evaluate = async (expression, timeoutMs = Math.min(5000, remaining())) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
      }, sessionId, Math.max(500, timeoutMs))
      if (result.exceptionDetails) {
        throw new WebReadError('PARSE_FAILED', '页面内容提取失败。', 'parse_error')
      }
      return result.result?.value
    }

    const waitForSelector = async (selector) => {
      const quoted = JSON.stringify(String(selector))
      const expression = `(() => { try { return document.querySelector(${quoted}) !== null } catch { return 'invalid' } })()`
      while (remaining() > 300) {
        const value = await evaluate(expression, Math.min(3000, remaining()))
        if (value === 'invalid') {
          throw new WebReadError('INVALID_SELECTOR', 'wait_for 不是合法的 CSS 选择器。', 'invalid_request')
        }
        if (value === true) {
          await sleep(200)
          return
        }
        await sleep(150)
      }
      throw new WebReadError('WAIT_FOR_TIMEOUT', '等待 wait_for 选择器超时。', 'timeout')
    }

    const waitForQuiet = async (quietMs, maxWaitMs) => {
      const start = Date.now()
      let quietSince = start
      while (remaining() > 250 && Date.now() - start < maxWaitMs) {
        if (state.inflight.size === 0) {
          if (Date.now() - quietSince >= quietMs) return
        } else {
          quietSince = Date.now()
        }
        await sleep(100)
      }
    }

    const session = {
      cdp,
      sessionId,
      targetId,
      state,
      executable,
      async navigate(url, navOptions = {}) {
        const mode = navOptions.mode === 'html' ? 'html' : navOptions.mode === 'js' ? 'js' : 'text'
        await cdp.send('Emulation.setScriptExecutionDisabled', { value: mode !== 'js' }, sessionId, 3000)
        const waitFor = typeof navOptions.waitFor === 'string' && navOptions.waitFor.trim() ? navOptions.waitFor.trim() : ''
        const timeoutAt = navOptions.deadline ?? deadline
        const remainingNav = () => timeoutAt - Date.now()
        if (remainingNav() <= 0) throw new WebReadError('TIMEOUT', '页面读取超时。', 'timeout')

        // 新一轮导航：清掉可能由 about:blank 或上一次导航留下的主文档状态。
        state.mainRequestId = null
        state.mainStatus = null
        state.mainMime = null
        state.mainBlocked = false
        state.navError = null
        state.finalUrl = null
        state.downloadBlocked = false

        const dcl = cdp.waitEvent(
          'Page.lifecycleEvent',
          (params) => params.name === 'DOMContentLoaded' && (!state.mainFrameId || params.frameId === state.mainFrameId),
          Math.min(8000, remainingNav()),
          sessionId,
        ).catch(() => null)
        const navigation = await cdp.send('Page.navigate', { url }, sessionId, Math.min(8000, remainingNav()))
        if (navigation.errorText) throw navigationError(navigation.errorText)
        state.mainFrameId = navigation.frameId || state.mainFrameId
        await Promise.race([dcl, sleep(Math.min(1500, Math.max(0, remainingNav())))])
        if (state.mainBlocked) throw new WebReadError('URL_BLOCKED', '目标地址被网络策略拦截。', 'blocked')
        if (remainingNav() <= 0) throw new WebReadError('TIMEOUT', '页面读取超时。', 'timeout')
        await sleep(mode === 'js' ? 350 : 150)
        if (waitFor) await waitForSelector(waitFor)
        else if (mode === 'js') await waitForQuiet(450, 2000)
        else await sleep(100)
        if (state.mainBlocked) throw new WebReadError('URL_BLOCKED', '目标地址被网络策略拦截。', 'blocked')
        if (state.navError && state.mainStatus === null) throw navigationError(state.navError)
        if (state.downloadBlocked) throw new WebReadError('DOWNLOAD_BLOCKED', '页面触发了下载，已被拒绝。', 'blocked')
        if (remainingNav() <= 0) throw new WebReadError('TIMEOUT', '页面读取超时。', 'timeout')
      },
      async extract(extractOptions = {}) {
        const mode = extractOptions.mode === 'html' ? 'html' : 'text'
        const args = {
          mode,
          maxChars: extractOptions.maxChars,
          includeLinks: extractOptions.includeLinks === true,
          withScripts: extractOptions.withScripts === true,
        }
        const expression = `(${extractInPage.toString()})(${JSON.stringify(args)})`
        const value = await evaluate(expression, Math.min(12000, Math.max(500, remaining())))
        if (!value || typeof value !== 'object') {
          throw new WebReadError('PARSE_FAILED', '页面没有可提取的内容。', 'parse_error')
        }

        // 用主文档原始 HTML（去掉脚本/样式）和渲染后正文对比：
        // 正文中有一部分只可能由 JS 生成时，补充 content-not-in-source 信号。
        if (args.withScripts && value.scripts && value.scripts.dynamic) {
          try {
            if (state.mainRequestId && remaining() > 300) {
              const bodyResult = await cdp.send('Network.getResponseBody', { requestId: state.mainRequestId }, sessionId, Math.min(2500, remaining()))
              let rawHtml = typeof bodyResult.body === 'string' ? bodyResult.body : ''
              if (bodyResult.base64Encoded === true) rawHtml = Buffer.from(rawHtml, 'base64').toString('utf8')
              if (rawHtml && contentNotInSource(value.text, rawHtml)) {
                value.scripts.dynamic.detected = true
                const signals = Array.isArray(value.scripts.dynamic.signals) ? value.scripts.dynamic.signals : []
                if (!signals.includes('content-not-in-source')) signals.push('content-not-in-source')
                value.scripts.dynamic.signals = signals
              }
            }
          } catch {
            /* 原始响应体可能已被 DevTools 缓冲淘汰；动态判断退回其他信号 */
          }
        }
        return value
      },
      async close() {
        if (closed) return
        closed = true
        try {
          await cdp.send('Target.closeTarget', { targetId }, undefined, 800)
        } catch {
          /* ignore */
        }
        try {
          await cdp.send('Browser.close', {}, undefined, 800)
        } catch {
          /* Browser.close 常常先断开 WebSocket */
        }
        cdp.close()
        const exitDeadline = Date.now() + 1500
        while (browser.exitCode === null && Date.now() < exitDeadline) await sleep(100)
        if (browser.exitCode === null) {
          try {
            browser.kill()
          } catch {
            /* ignore */
          }
        }
      },
    }
    return session
  } catch (error) {
    try {
      cdp?.close()
    } catch {
      /* ignore */
    }
    if (browser && browser.exitCode === null) {
      try {
        browser.kill()
      } catch {
        /* ignore */
      }
    }
    throw error
  }
}
