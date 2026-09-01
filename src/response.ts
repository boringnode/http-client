import type { ResponseBody, ResponseHeaders } from './types/main.js'
import { HttpError } from './exceptions.js'

interface ResponseInit {
  status: number
  headers: ResponseHeaders
}

/** A response whose body has already been consumed and can be read more than once. */
export class HttpResponse<SuccessBody = unknown, ErrorBody = unknown> {
  readonly status: number
  readonly headers: ResponseHeaders
  readonly #body: Uint8Array

  constructor(init: ResponseInit & { body: Uint8Array }) {
    this.status = init.status
    this.headers = init.headers
    this.#body = init.body
  }

  text(): string {
    return new TextDecoder().decode(this.#body)
  }

  json(): SuccessBody | ErrorBody
  json<T>(): T
  json<T = SuccessBody | ErrorBody>(): T {
    return JSON.parse(this.text()) as T
  }

  bytes(): Uint8Array {
    return this.#body.slice()
  }

  header(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()]
  }

  failed(): boolean {
    return this.status >= 400
  }

  throwIfFailed(): HttpResponse<SuccessBody, never> {
    if (this.failed()) {
      throw new HttpError(this)
    }

    // The status check above removes the error response body from the static view.
    return this as unknown as HttpResponse<SuccessBody, never>
  }
}

/** A response whose body must be consumed or destroyed by the caller. */
export class HttpStreamResponse {
  readonly status: number
  readonly headers: ResponseHeaders
  readonly body: ResponseBody

  constructor(init: ResponseInit & { body: ResponseBody }) {
    this.status = init.status
    this.headers = init.headers
    this.body = init.body
  }

  header(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()]
  }

  failed(): boolean {
    return this.status >= 400
  }

  throwIfFailed(): this {
    if (this.failed()) {
      throw new HttpError(this)
    }

    return this
  }
}
