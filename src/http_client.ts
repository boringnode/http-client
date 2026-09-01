import { Agent, interceptors, type Dispatcher } from 'undici'
import { ResponseTooLargeError } from './exceptions.js'
import { HttpResponse, HttpStreamResponse } from './response.js'
import type {
  Headers,
  HttpClientOptions,
  HttpMethod,
  Query,
  RequestOptions,
  StreamRequestOptions,
} from './types/main.js'

const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5

interface DispatcherReference {
  dispatcher: Dispatcher
  owned: boolean
}

/** A reusable HTTP client backed by one long-lived Undici dispatcher. */
export class HttpClient {
  readonly #options: Omit<HttpClientOptions, 'dispatcher' | 'transport'>
  readonly #dispatcher: DispatcherReference
  readonly #redirectDispatchers = new Map<number, Dispatcher>()
  #disposed = false

  constructor(options: HttpClientOptions = {}) {
    this.#options = normalizeOptions(options)

    if (typeof options.dispatcher === 'function') {
      this.#dispatcher = { dispatcher: options.dispatcher(), owned: true }
    } else if (options.dispatcher) {
      this.#dispatcher = { dispatcher: options.dispatcher, owned: false }
    } else {
      this.#dispatcher = { dispatcher: new Agent(options.transport), owned: true }
    }
  }

  /** Create a client with merged defaults that borrows this client's dispatcher. */
  withOptions(options: Omit<HttpClientOptions, 'dispatcher' | 'transport'>): HttpClient {
    const client = new HttpClient({
      ...this.#options,
      ...options,
      headers: mergeHeaders(this.#options.headers, options.headers),
      query: { ...this.#options.query, ...options.query },
      dispatcher: this.#dispatcher.dispatcher,
    })

    return client
  }

  async request(
    method: HttpMethod,
    path: string | URL,
    options: RequestOptions = {}
  ): Promise<HttpResponse> {
    const response = await this.#dispatch(method, path, options)
    const chunks: Uint8Array[] = []
    const limit = this.#options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE
    let size = 0

    try {
      for await (const chunk of response.body) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)
        size += bytes.byteLength

        if (size > limit) {
          throw new ResponseTooLargeError(limit)
        }

        chunks.push(bytes)
      }
    } catch (error) {
      response.body.destroy(error instanceof Error ? error : undefined)
      throw error
    }

    return new HttpResponse({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks, size),
    })
  }

  get(path: string | URL, options?: RequestOptions): Promise<HttpResponse> {
    return this.request('GET', path, options)
  }

  post(path: string | URL, options?: RequestOptions): Promise<HttpResponse> {
    return this.request('POST', path, options)
  }

  put(path: string | URL, options?: RequestOptions): Promise<HttpResponse> {
    return this.request('PUT', path, options)
  }

  patch(path: string | URL, options?: RequestOptions): Promise<HttpResponse> {
    return this.request('PATCH', path, options)
  }

  delete(path: string | URL, options?: RequestOptions): Promise<HttpResponse> {
    return this.request('DELETE', path, options)
  }

  /** Return an unconsumed body. The caller must consume, dump, or destroy it. */
  async stream(
    path: string | URL,
    options: StreamRequestOptions = {}
  ): Promise<HttpStreamResponse> {
    const response = await this.#dispatch(options.method ?? 'GET', path, options)

    return new HttpStreamResponse({
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
    })
  }

  /** Gracefully close this client's dispatcher when the client owns it. */
  async close(): Promise<void> {
    if (this.#dispatcher.owned && !this.#disposed) {
      this.#disposed = true
      await this.#dispatcher.dispatcher.close()
    }
  }

  /** Abort requests and destroy this client's dispatcher when the client owns it. */
  async destroy(error?: Error): Promise<void> {
    if (this.#dispatcher.owned && !this.#disposed) {
      this.#disposed = true
      await this.#dispatcher.dispatcher.destroy(error ?? null)
    }
  }

  async #dispatch(method: HttpMethod, path: string | URL, options: RequestOptions) {
    const url = resolveUrl(path, this.#options.baseUrl)
    const applyDefaults = isWithinBaseOrigin(url, this.#options.baseUrl)
    const query = { ...(applyDefaults ? this.#options.query : {}), ...options.query }
    appendQuery(url, query)

    const headers = mergeHeaders(applyDefaults ? this.#options.headers : undefined, options.headers)
    let body = options.body

    if ('json' in options) {
      const serialized = JSON.stringify(options.json)
      if (serialized === undefined) {
        throw new TypeError('Cannot serialize the request JSON body')
      }

      body = serialized
      if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json'
      }
    }

    const timeout = options.timeout ?? this.#options.timeout
    const maxRedirects = options.maxRedirects ?? this.#options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    validateNonNegativeInteger('timeout', timeout)
    validateNonNegativeInteger(
      'headersTimeout',
      options.headersTimeout ?? this.#options.headersTimeout
    )
    validateNonNegativeInteger('bodyTimeout', options.bodyTimeout ?? this.#options.bodyTimeout)
    validateNonNegativeInteger('maxRedirects', maxRedirects)
    const dispatcher = this.#getDispatcher(maxRedirects)

    return dispatcher.request({
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method,
      body,
      headers: toUndiciHeaders(headers),
      headersTimeout: options.headersTimeout ?? this.#options.headersTimeout,
      bodyTimeout: options.bodyTimeout ?? this.#options.bodyTimeout,
      signal: createRequestSignal(options.signal, timeout),
    })
  }

  #getDispatcher(maxRedirects: number): Dispatcher {
    if (maxRedirects === 0) {
      return this.#dispatcher.dispatcher
    }

    let dispatcher = this.#redirectDispatchers.get(maxRedirects)
    if (!dispatcher) {
      dispatcher = this.#dispatcher.dispatcher.compose(
        interceptors.redirect({ maxRedirections: maxRedirects })
      )
      this.#redirectDispatchers.set(maxRedirects, dispatcher)
    }

    return dispatcher
  }
}

function normalizeOptions(
  options: HttpClientOptions
): Omit<HttpClientOptions, 'dispatcher' | 'transport'> {
  validateNonNegativeInteger('timeout', options.timeout)
  validateNonNegativeInteger('headersTimeout', options.headersTimeout)
  validateNonNegativeInteger('bodyTimeout', options.bodyTimeout)
  validateNonNegativeInteger('maxResponseSize', options.maxResponseSize)
  validateNonNegativeInteger('maxRedirects', options.maxRedirects)

  return {
    baseUrl: options.baseUrl ? new URL(options.baseUrl) : undefined,
    headers: mergeHeaders(options.headers),
    query: { ...options.query },
    timeout: options.timeout,
    headersTimeout: options.headersTimeout,
    bodyTimeout: options.bodyTimeout,
    maxRedirects: options.maxRedirects,
    maxResponseSize: options.maxResponseSize,
  }
}

function resolveUrl(path: string | URL, baseUrl?: string | URL): URL {
  if (path instanceof URL) {
    return new URL(path)
  }

  try {
    return baseUrl ? new URL(path, baseUrl) : new URL(path)
  } catch {
    throw new TypeError(`Cannot resolve relative URL "${path}" without a baseUrl`)
  }
}

function isWithinBaseOrigin(url: URL, baseUrl?: string | URL): boolean {
  return !baseUrl || url.origin === new URL(baseUrl).origin
}

function createRequestSignal(signal: AbortSignal | undefined, timeout: number | undefined) {
  if (!timeout) {
    return signal
  }

  const timeoutSignal = AbortSignal.timeout(timeout)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function validateNonNegativeInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be an integer greater than or equal to zero`)
  }
}

function appendQuery(url: URL, query: Query): void {
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.delete(name)

    if (value === null || value === undefined) {
      continue
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item))
    }
  }
}

function mergeHeaders(...groups: (Headers | undefined)[]): Headers {
  const merged: Headers = {}

  for (const headers of groups) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      merged[name.toLowerCase()] = value
    }
  }

  return merged
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers[name.toLowerCase()] !== undefined
}

function toUndiciHeaders(headers: Headers): Record<string, string | number | string[] | undefined> {
  const normalized: Record<string, string | number | string[] | undefined> = {}

  for (const [name, value] of Object.entries(headers)) {
    normalized[name] = typeof value === 'object' ? [...value] : value
  }

  return normalized
}
