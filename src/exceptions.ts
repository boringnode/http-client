import type { HttpResponse, HttpStreamResponse } from './response.js'

/** Raised by `throwIfFailed` for an HTTP response with a 4xx or 5xx status. */
export class HttpError extends Error {
  readonly name = 'HttpError'

  constructor(readonly response: HttpResponse<unknown, unknown> | HttpStreamResponse) {
    super(`HTTP request failed with status ${response.status}`)
  }
}

/** Raised when a buffered response exceeds the configured byte limit. */
export class ResponseTooLargeError extends Error {
  readonly name = 'ResponseTooLargeError'

  constructor(readonly limit: number) {
    super(`HTTP response exceeded the ${limit} byte limit`)
  }
}
