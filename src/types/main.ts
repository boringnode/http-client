import type { Readable } from 'node:stream'
import type { Agent, Dispatcher, FormData } from 'undici'

export type HttpMethod = Dispatcher.HttpMethod
export type ResponseHeaders = Dispatcher.ResponseData['headers']
export type ResponseBody = Dispatcher.ResponseData['body']

export type HeaderValue = string | number | readonly string[] | undefined
export type Headers = Record<string, HeaderValue>

export type QueryPrimitive = string | number | boolean
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | null | undefined
export type Query = Record<string, QueryValue>
export type PathParameters = Record<string, string | number | boolean>

export type RawBody = string | Buffer | Uint8Array | Readable | FormData | null

export type DispatcherFactory = () => Dispatcher

/** Common connection settings for the default Undici Agent. */
export type TransportOptions = Pick<
  Agent.Options,
  | 'allowH2'
  | 'connect'
  | 'connections'
  | 'connectTimeout'
  | 'keepAliveMaxTimeout'
  | 'keepAliveTimeout'
  | 'maxHeaderSize'
  | 'pipelining'
>

export interface HttpClientOptions {
  /** Base URL used to resolve relative request paths. */
  baseUrl?: string | URL
  /** Headers sent with every request. Request headers override them by name. */
  headers?: Headers
  /** Query parameters sent with every request. Request query values override them by name. */
  query?: Query
  /** Maximum total request duration in milliseconds. Set to 0 to disable it. */
  timeout?: number
  /** Time allowed to receive complete response headers. Set to 0 to disable it. */
  headersTimeout?: number
  /** Maximum inactivity between response body chunks. Set to 0 to disable it. */
  bodyTimeout?: number
  /** Maximum redirects to follow. Defaults to 5. Set to 0 to return redirects as responses. */
  maxRedirects?: number
  /** Maximum buffered response size. Defaults to 10 MiB. */
  maxResponseSize?: number
  /** Borrow a dispatcher, or create an owned dispatcher once through a factory. */
  dispatcher?: Dispatcher | DispatcherFactory
  /** Options for the default long-lived Undici Agent. Ignored when dispatcher is set. */
  transport?: TransportOptions
}

interface SharedRequestOptions {
  params?: PathParameters
  headers?: Headers
  query?: Query
  timeout?: number
  headersTimeout?: number
  bodyTimeout?: number
  maxRedirects?: number
  signal?: AbortSignal
}

export type RequestOptions = SharedRequestOptions &
  ({ body?: RawBody; json?: never } | { body?: never; json: unknown })

export type StreamRequestOptions = RequestOptions & { method?: HttpMethod }

export interface HttpClientManagerOptions<
  KnownClients extends Record<string, HttpClientOptions>,
  DefaultClient extends keyof KnownClients = keyof KnownClients,
> {
  default?: DefaultClient
  clients: KnownClients
}
