import assert from 'node:assert/strict'
import { MockAgent, type Dispatcher, type MockPool } from 'undici'
import type { HttpClientOptions, HttpMethod } from './types/main.js'

type ClientName<KnownClients> = keyof KnownClients & string
type RequestBody = Dispatcher.DispatchOptions['body']
type HeaderMatcher = string | RegExp | ((value: string) => boolean)
type JsonMatcher = unknown | ((json: unknown) => boolean)
type MockInterceptor = ReturnType<MockPool['intercept']>
type MockScope = ReturnType<MockInterceptor['reply']>

export const httpClientFakeDispatcher = Symbol('httpClientFakeDispatcher')

export type HttpClientFakeBody = string | Buffer | Uint8Array | null

export interface HttpClientFakeRequest<Client extends string = string> {
  client: Client
  method: HttpMethod
  url: string
  headers: Record<string, string | string[]>
  body: HttpClientFakeBody | undefined
}

interface HttpClientFakeInterceptBaseOptions {
  method?: HttpMethod
  path: string | URL
  headers?: Record<string, HeaderMatcher>
}

type HttpClientFakeInterceptBody = string | RegExp | ((body: RequestBody | undefined) => boolean)

export type HttpClientFakeInterceptOptions = HttpClientFakeInterceptBaseOptions &
  ({ body?: HttpClientFakeInterceptBody; json?: never } | { body?: never; json: JsonMatcher })

interface HttpClientFakeRequestQueryBase {
  method?: HttpMethod
  path?: string | URL | RegExp | ((url: URL) => boolean)
  headers?: Record<string, string | string[]>
}

export type HttpClientFakeRequestQuery = HttpClientFakeRequestQueryBase &
  (
    | {
        body?: HttpClientFakeBody | ((body: HttpClientFakeBody | undefined) => boolean)
        json?: never
      }
    | { body?: never; json: JsonMatcher }
  )

export type HttpClientFakeCountQuery<Client extends string = string> =
  HttpClientFakeRequestQuery & {
    client?: Client
  }

export interface HttpClientFakeScope {
  delay(milliseconds: number): this
  times(count: number): this
  persist(): this
}

export interface HttpClientFakeInterceptor {
  reply(
    statusCode: number,
    body?: unknown,
    headers?: Record<string, string | string[]>
  ): HttpClientFakeScope
  replyWithError(error: Error): HttpClientFakeScope
}

/** An in-memory HTTP transport for requests made through an HttpClientManager. */
export interface HttpClientFake<KnownClients extends Record<string, HttpClientOptions>> {
  readonly requests: HttpClientFakeRequest<ClientName<KnownClients>>[]
  intercept<Client extends ClientName<KnownClients>>(
    client: Client,
    options: HttpClientFakeInterceptOptions
  ): HttpClientFakeInterceptor
  clear(): void
  assertSent<Client extends ClientName<KnownClients>>(
    client: Client,
    query?: HttpClientFakeRequestQuery
  ): void
  assertNotSent<Client extends ClientName<KnownClients>>(
    client: Client,
    query?: HttpClientFakeRequestQuery
  ): void
  assertSentCount(count: number, query?: HttpClientFakeCountQuery<ClientName<KnownClients>>): void
  assertNothingSent(): void
  assertNothingPending(): void
  restore(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface HttpClientFakeController<
  KnownClients extends Record<string, HttpClientOptions>,
> extends HttpClientFake<KnownClients> {
  [httpClientFakeDispatcher](client: ClientName<KnownClients>): Dispatcher
  destroy(error?: Error): Promise<void>
}

export function createHttpClientFake<KnownClients extends Record<string, HttpClientOptions>>(
  clients: KnownClients,
  restoreManager: (restoration: Promise<void>) => void
): HttpClientFakeController<KnownClients> {
  return new HttpClientFakeImplementation(clients, restoreManager)
}

class HttpClientFakeScopeImplementation implements HttpClientFakeScope {
  constructor(private readonly scope: MockScope) {}

  delay(milliseconds: number): this {
    this.scope.delay(milliseconds)
    return this
  }

  times(count: number): this {
    this.scope.times(count)
    return this
  }

  persist(): this {
    this.scope.persist()
    return this
  }
}

class HttpClientFakeInterceptorImplementation implements HttpClientFakeInterceptor {
  constructor(private readonly interceptor: MockInterceptor) {}

  reply(
    statusCode: number,
    body?: unknown,
    headers: Record<string, string | string[]> = {}
  ): HttpClientFakeScope {
    const response = serializeResponse(body, headers)
    return new HttpClientFakeScopeImplementation(
      this.interceptor.reply(statusCode, response.body, { headers: response.headers })
    )
  }

  replyWithError(error: Error): HttpClientFakeScope {
    return new HttpClientFakeScopeImplementation(this.interceptor.replyWithError(error))
  }
}

class HttpClientFakeImplementation<
  KnownClients extends Record<string, HttpClientOptions>,
> implements HttpClientFakeController<KnownClients> {
  readonly #agents = new Map<ClientName<KnownClients>, MockAgent>()
  readonly #dispatchers = new Map<ClientName<KnownClients>, Dispatcher>()
  readonly #requests: HttpClientFakeRequest<ClientName<KnownClients>>[] = []
  readonly #activeRequests = new Set<Dispatcher.DispatchController>()
  #restoration?: Promise<void>

  constructor(
    private readonly clients: KnownClients,
    private readonly restoreManager: (restoration: Promise<void>) => void
  ) {}

  get requests(): HttpClientFakeRequest<ClientName<KnownClients>>[] {
    return this.#requests.map((request) => ({
      ...request,
      headers: cloneHeaders(request.headers),
      body: cloneBody(request.body),
    }))
  }

  intercept<Client extends ClientName<KnownClients>>(
    client: Client,
    options: HttpClientFakeInterceptOptions
  ): HttpClientFakeInterceptor {
    const url = this.#resolveUrl(client, options.path)
    const agent = this.#getAgent(client)
    const body = createBodyMatcher(options)
    const interceptor = agent.get<MockPool>(url.origin).intercept({
      method: options.method,
      path: (path) => urlsEqual(new URL(path, url.origin), url),
      headers: createHeaderMatchers(options.headers),
      body,
    })

    return new HttpClientFakeInterceptorImplementation(interceptor)
  }

  clear(): void {
    this.#requests.length = 0
  }

  assertSent<Client extends ClientName<KnownClients>>(
    client: Client,
    query: HttpClientFakeRequestQuery = {}
  ): void {
    const requests = this.#matchingRequests(client, query)
    assert.ok(
      requests.length > 0,
      `Expected an HTTP request matching ${formatQuery(client, query)} to have been sent`
    )
  }

  assertNotSent<Client extends ClientName<KnownClients>>(
    client: Client,
    query: HttpClientFakeRequestQuery = {}
  ): void {
    const requests = this.#matchingRequests(client, query)
    assert.equal(
      requests.length,
      0,
      `Expected no HTTP request matching ${formatQuery(client, query)} to have been sent`
    )
  }

  assertSentCount(
    count: number,
    query: HttpClientFakeCountQuery<ClientName<KnownClients>> = {}
  ): void {
    const requests = this.#requests.filter((request) => {
      return (!query.client || request.client === query.client) && this.#matches(request, query)
    })
    assert.equal(requests.length, count, `Expected ${count} matching HTTP request(s) to be sent`)
  }

  assertNothingSent(): void {
    assert.equal(this.#requests.length, 0, 'Expected no HTTP requests to be sent')
  }

  assertNothingPending(): void {
    for (const agent of this.#agents.values()) {
      agent.assertNoPendingInterceptors()
    }
  }

  restore(): Promise<void> {
    return this.#finish()
  }

  destroy(error: Error = new Error('HTTP client fake destroyed')): Promise<void> {
    for (const controller of this.#activeRequests) {
      controller.abort(error)
    }
    return this.#finish()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.restore()
  }

  [httpClientFakeDispatcher](client: ClientName<KnownClients>): Dispatcher {
    let dispatcher = this.#dispatchers.get(client)
    if (dispatcher) {
      return dispatcher
    }

    const agent = this.#getAgent(client)
    dispatcher = agent.compose((dispatch) => (options, handler) => {
      const origin = options.origin instanceof URL ? options.origin.origin : options.origin
      const url = new URL(options.path, origin)
      this.#requests.push({
        client,
        method: options.method,
        url: url.toString(),
        headers: normalizeHeaders(options.headers),
        body: snapshotBody(options.body),
      })
      return dispatch(options, this.#trackRequest(handler))
    })
    this.#dispatchers.set(client, dispatcher)
    return dispatcher
  }

  #finish(): Promise<void> {
    if (!this.#restoration) {
      this.#restoration = Promise.all(
        [...this.#agents.values()].map((agent) => agent.close())
      ).then(() => undefined)
      this.restoreManager(this.#restoration)
    }
    return this.#restoration
  }

  #trackRequest(handler: Dispatcher.DispatchHandler): Dispatcher.DispatchHandler {
    return new Proxy(handler, {
      get: (target, property) => {
        if (property === 'onRequestStart') {
          return (controller: Dispatcher.DispatchController, context: unknown) => {
            this.#activeRequests.add(controller)
            target.onRequestStart?.(controller, context)
          }
        }
        if (property === 'onResponseEnd') {
          return (controller: Dispatcher.DispatchController, trailers: Record<string, string>) => {
            this.#activeRequests.delete(controller)
            target.onResponseEnd?.(controller, trailers)
          }
        }
        if (property === 'onResponseError') {
          return (controller: Dispatcher.DispatchController, error: Error) => {
            this.#activeRequests.delete(controller)
            target.onResponseError?.(controller, error)
          }
        }

        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  #getAgent(client: ClientName<KnownClients>): MockAgent {
    let agent = this.#agents.get(client)
    if (!agent) {
      agent = new MockAgent()
      agent.disableNetConnect()
      this.#agents.set(client, agent)
    }
    return agent
  }

  #resolveUrl(client: ClientName<KnownClients>, path: string | URL): URL {
    if (path instanceof URL) {
      return new URL(path)
    }

    try {
      const baseUrl = this.clients[client].baseUrl
      return baseUrl ? new URL(path, baseUrl) : new URL(path)
    } catch {
      throw new TypeError(
        `Cannot resolve relative fake URL "${path}" for client "${client}" without a baseUrl`
      )
    }
  }

  #matchingRequests(
    client: ClientName<KnownClients>,
    query: HttpClientFakeRequestQuery
  ): HttpClientFakeRequest<ClientName<KnownClients>>[] {
    return this.#requests.filter(
      (request) => request.client === client && this.#matches(request, query)
    )
  }

  #matches(
    request: HttpClientFakeRequest<ClientName<KnownClients>>,
    query: HttpClientFakeRequestQuery
  ): boolean {
    if (query.method && request.method !== query.method) {
      return false
    }
    if (query.path !== undefined && !this.#matchesUrl(request, query.path)) {
      return false
    }
    if (query.headers && !matchesHeaders(request.headers, query.headers)) {
      return false
    }
    if ('body' in query && !matchesValue(request.body, query.body)) {
      return false
    }
    if ('json' in query && !matchesJson(request.body, query.json)) {
      return false
    }
    return true
  }

  #matchesUrl(
    request: HttpClientFakeRequest<ClientName<KnownClients>>,
    matcher: NonNullable<HttpClientFakeRequestQuery['path']>
  ): boolean {
    const requestUrl = new URL(request.url)
    if (typeof matcher === 'function') {
      return matcher(requestUrl)
    }
    if (matcher instanceof RegExp) {
      matcher.lastIndex = 0
      return matcher.test(request.url)
    }
    return urlsEqual(requestUrl, this.#resolveUrl(request.client, matcher))
  }
}

function createBodyMatcher(
  options: HttpClientFakeInterceptOptions
): ((body: string) => boolean) | string | RegExp | undefined {
  if ('json' in options) {
    return (body) => matchesJson(body, options.json)
  }
  if (typeof options.body === 'function') {
    return options.body as (body: string) => boolean
  }
  if (options.body instanceof RegExp) {
    return (body) => testRegExp(options.body as RegExp, body)
  }
  return options.body
}

function createHeaderMatchers(
  headers: Record<string, HeaderMatcher> | undefined
): Record<string, HeaderMatcher> | undefined {
  if (!headers) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, matcher]) => [
      name,
      matcher instanceof RegExp ? (value: string) => testRegExp(matcher, value) : matcher,
    ])
  )
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Cannot serialize the fake request JSON body')
  }
  return serialized
}

function serializeResponse(body: unknown, headers: Record<string, string | string[]>) {
  const responseHeaders = { ...headers }
  if (body === undefined || typeof body === 'string' || Buffer.isBuffer(body)) {
    return { body, headers: responseHeaders }
  }
  if (body instanceof Uint8Array) {
    return { body: Buffer.from(body), headers: responseHeaders }
  }

  if (!Object.keys(responseHeaders).some((name) => name.toLowerCase() === 'content-type')) {
    responseHeaders['content-type'] = 'application/json'
  }
  return { body: serializeJson(body), headers: responseHeaders }
}

function normalizeHeaders(
  headers: Dispatcher.DispatchOptions['headers']
): Record<string, string | string[]> {
  if (!headers) {
    return {}
  }

  const normalized: Record<string, string | string[]> = {}
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      normalized[headers[index].toLowerCase()] = headers[index + 1]
    }
    return normalized
  }

  if (Symbol.iterator in Object(headers)) {
    for (const [name, value] of headers as Iterable<[string, string | string[] | undefined]>) {
      if (value !== undefined) {
        normalized[name.toLowerCase()] = Array.isArray(value) ? [...value] : String(value)
      }
    }
    return normalized
  }

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value)
    }
  }
  return normalized
}

function cloneHeaders(
  headers: Record<string, string | string[]>
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ])
  )
}

function snapshotBody(body: RequestBody | undefined): HttpClientFakeBody | undefined {
  if (body === null || typeof body === 'string') {
    return body
  }
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body)
  }
  if (body instanceof Uint8Array) {
    return new Uint8Array(body)
  }
  return undefined
}

function cloneBody(body: HttpClientFakeBody | undefined): HttpClientFakeBody | undefined {
  return snapshotBody(body)
}

function matchesHeaders(
  actual: Record<string, string | string[]>,
  expected: Record<string, string | string[]>
): boolean {
  return Object.entries(expected).every(([name, value]) => {
    return isDeepEqual(actual[name.toLowerCase()], value)
  })
}

function matchesValue<Value>(
  actual: Value,
  expected: Value | ((value: Value) => boolean)
): boolean {
  if (typeof expected === 'function') {
    return (expected as (value: Value) => boolean)(actual)
  }
  return isDeepEqual(actual, expected)
}

function matchesJson(body: HttpClientFakeBody | undefined, matcher: JsonMatcher): boolean {
  try {
    const json = JSON.parse(bodyToString(body)) as unknown
    return typeof matcher === 'function' ? matcher(json) : isDeepEqual(json, matcher)
  } catch {
    return false
  }
}

function bodyToString(body: HttpClientFakeBody | undefined): string {
  if (typeof body === 'string') {
    return body
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Buffer.from(body).toString()
  }
  throw new TypeError('The request body cannot be read as JSON')
}

function urlsEqual(left: URL, right: URL): boolean {
  return normalizeUrl(left) === normalizeUrl(right)
}

function normalizeUrl(url: URL): string {
  const normalized = new URL(url)
  normalized.searchParams.sort()
  return normalized.toString()
}

function testRegExp(expression: RegExp, value: string): boolean {
  expression.lastIndex = 0
  return expression.test(value)
}

function isDeepEqual(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function formatQuery(client: string, query: HttpClientFakeRequestQuery): string {
  const fields = [`client=${JSON.stringify(client)}`]
  if (query.method) {
    fields.push(`method=${query.method}`)
  }
  if (typeof query.path === 'string' || query.path instanceof URL) {
    fields.push(`path=${JSON.stringify(query.path.toString())}`)
  }
  return fields.join(', ')
}
