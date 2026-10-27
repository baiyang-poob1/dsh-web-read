export class WebReadError extends Error {
  constructor(code, message, status = 'internal_error', options = {}) {
    super(message)
    this.name = 'WebReadError'
    this.code = code
    this.status = status
    this.retryable = options.retryable === true
  }
}

export function isAbortError(error) {
  return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

export function toPublicError(error) {
  if (error instanceof WebReadError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    }
  }
  return {
    status: 'internal_error',
    code: 'INTERNAL_ERROR',
    message: '网页读取进程发生内部错误。',
  }
}
