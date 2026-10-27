/**
 * dsh-web-read / worker/cdp.mjs
 *
 * 最小 Chrome DevTools Protocol 客户端：只为读取页面服务。
 * 不提供任意 Runtime.evaluate 给模型；调用方只会发送固定的几条命令。
 */

export class CdpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      reject(new CdpError('CDP_CONNECT_FAILED', `WebSocket unavailable: ${error?.message ?? error}`))
      return
    }
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      reject(new CdpError('CDP_CONNECT_TIMEOUT', 'DevTools connection timed out.'))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new CdpError('CDP_CONNECT_FAILED', 'DevTools connection failed.'))
    }, { once: true })
  })
}

export class CdpConnection {
  constructor(ws, options = {}) {
    this.ws = ws
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10000
    this.nextId = 1
    this.pending = new Map()
    this.waiters = new Set()
    this.eventListeners = new Set()
    this.closed = false

    ws.addEventListener('message', (event) => {
      let text
      if (typeof event.data === 'string') text = event.data
      else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString('utf8')
      else text = String(event.data ?? '')
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
          pending.reject(new CdpError(String(message.error.code ?? 'CDP_ERROR'), String(message.error.message ?? 'CDP command failed.')))
        } else {
          pending.resolve(message.result ?? {})
        }
        return
      }
      if (typeof message.method === 'string') {
        for (const listener of [...this.eventListeners]) {
          try {
            listener(message.method, message.params ?? {}, message.sessionId)
          } catch {
            /* event listeners must not break the protocol */
          }
        }
        for (const waiter of [...this.waiters]) {
          if (waiter.method !== message.method) continue
          if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue
          let matched = false
          try {
            matched = waiter.predicate(message.params ?? {}, message)
          } catch {
            matched = false
          }
          if (!matched) continue
          this.waiters.delete(waiter)
          clearTimeout(waiter.timer)
          waiter.resolve(message.params ?? {})
        }
      }
    })

    ws.addEventListener('close', () => {
      this.closed = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new CdpError('CDP_CLOSED', 'DevTools connection closed.'))
      }
      this.pending.clear()
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new CdpError('CDP_CLOSED', 'DevTools connection closed.'))
      }
      this.waiters.clear()
    })
    ws.addEventListener('error', () => {
      /* close handler rejects pending work */
    })
  }

  static async connect(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000
    const ws = await openWebSocket(url, timeoutMs)
    return new CdpConnection(ws, { defaultTimeoutMs: options.defaultTimeoutMs ?? 10000 })
  }

  send(method, params = {}, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(new CdpError('CDP_CLOSED', 'DevTools connection closed.'))
    const id = this.nextId++
    const effectiveTimeout = Math.max(1, timeoutMs ?? this.defaultTimeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError('CDP_TIMEOUT', `DevTools command timed out: ${method}`))
      }, effectiveTimeout)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError('CDP_SEND_FAILED', `DevTools send failed: ${error?.message ?? error}`))
      }
    })
  }

  waitEvent(method, predicate = () => true, timeoutMs = this.defaultTimeoutMs, sessionId) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        sessionId,
        resolve,
        reject,
        timer: null,
      }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new CdpError('CDP_EVENT_TIMEOUT', `Timed out waiting for ${method}.`))
      }, Math.max(1, timeoutMs))
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}
