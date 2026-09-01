import { HttpClient } from './http_client.js'
import type {
  HttpClientManagerOptions,
  HttpClientOptions,
  HttpMethod,
  RequestOptions,
  StreamRequestOptions,
} from './types/main.js'

/** Lazily creates and caches named HTTP clients. */
export class HttpClientManager<KnownClients extends Record<string, HttpClientOptions>> {
  readonly #config: HttpClientManagerOptions<KnownClients>
  #clients: Partial<Record<keyof KnownClients, HttpClient>> = {}

  constructor(config: HttpClientManagerOptions<KnownClients>) {
    this.#config = config
  }

  use<ClientName extends keyof KnownClients>(name?: ClientName): HttpClient {
    const clientName: keyof KnownClients | undefined = name || this.#config.default

    if (!clientName) {
      throw new Error('Cannot create HTTP client. No default client is defined in the config')
    }

    const cached = this.#clients[clientName]
    if (cached) {
      return cached
    }

    if (!Object.hasOwn(this.#config.clients, clientName)) {
      throw new Error(`Cannot create HTTP client. Client "${String(clientName)}" is not defined`)
    }

    const client = new HttpClient(this.#config.clients[clientName])
    this.#clients[clientName] = client
    return client
  }

  request(method: HttpMethod, path: string | URL, options?: RequestOptions) {
    return this.use().request(method, path, options)
  }

  get(path: string | URL, options?: RequestOptions) {
    return this.use().get(path, options)
  }

  post(path: string | URL, options?: RequestOptions) {
    return this.use().post(path, options)
  }

  put(path: string | URL, options?: RequestOptions) {
    return this.use().put(path, options)
  }

  patch(path: string | URL, options?: RequestOptions) {
    return this.use().patch(path, options)
  }

  delete(path: string | URL, options?: RequestOptions) {
    return this.use().delete(path, options)
  }

  stream(path: string | URL, options?: StreamRequestOptions) {
    return this.use().stream(path, options)
  }

  async close(): Promise<void> {
    const clients = Object.values(this.#clients) as HttpClient[]
    this.#clients = {}
    await Promise.all(clients.map((client) => client.close()))
  }

  async destroy(error?: Error): Promise<void> {
    const clients = Object.values(this.#clients) as HttpClient[]
    this.#clients = {}
    await Promise.all(clients.map((client) => client.destroy(error)))
  }
}
