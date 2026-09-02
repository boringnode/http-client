import { HttpClient, httpClientDispatcher } from './http_client.js'
import {
  createHttpClientFake,
  httpClientFakeDispatcher,
  type HttpClientFake,
  type HttpClientFakeController,
} from './http_client_fake.js'
import type { Dispatcher } from 'undici'
import type { ClientPath, ClientRequestArguments, InferClientApi } from './openapi.js'
import type {
  HttpClientManagerOptions,
  HttpClientOptions,
  HttpMethod,
  StreamRequestOptions,
} from './types/main.js'

type ManagedClients<KnownClients extends Record<string, HttpClientOptions>> = {
  [ClientName in keyof KnownClients]: HttpClient<InferClientApi<KnownClients[ClientName]>>
}

/** Lazily creates and caches named HTTP clients. */
export class HttpClientManager<
  KnownClients extends Record<string, HttpClientOptions>,
  DefaultClient extends keyof KnownClients = keyof KnownClients,
> {
  readonly #config: HttpClientManagerOptions<KnownClients, DefaultClient>
  #clients: Partial<ManagedClients<KnownClients>> = {}
  #fake?: HttpClientFakeController<KnownClients>
  #restoringFake?: HttpClientFakeController<KnownClients>
  #fakeRestoration?: Promise<void>

  constructor(config: HttpClientManagerOptions<KnownClients, DefaultClient>) {
    this.#config = config
  }

  use<ClientName extends keyof KnownClients = DefaultClient>(
    name?: ClientName
  ): ManagedClients<KnownClients>[ClientName] {
    const selectedName: keyof KnownClients | undefined = name || this.#config.default

    if (!selectedName) {
      throw new Error('Cannot create HTTP client. No default client is defined in the config')
    }

    const clientName = selectedName as ClientName

    const cached = this.#clients[clientName]
    if (cached) {
      return cached
    }

    if (!Object.hasOwn(this.#config.clients, clientName)) {
      throw new Error(`Cannot create HTTP client. Client "${String(clientName)}" is not defined`)
    }

    const options = this.#config.clients[clientName]
    const client = new HttpClient<InferClientApi<KnownClients[typeof clientName]>>({
      ...options,
      dispatcher: this.#fake
        ? this.#fake[httpClientFakeDispatcher](String(clientName) as keyof KnownClients & string)
        : options.dispatcher,
    })
    this.#clients[clientName] = client
    return client
  }

  /** Replace managed clients with isolated in-memory HTTP transports. */
  fake(): HttpClientFake<KnownClients> {
    if (this.#fake || this.#fakeRestoration) {
      throw new Error('Cannot fake HTTP clients. A fake is already active or being restored')
    }

    const clients = this.#clients
    this.#clients = { ...clients }
    const originalDispatchers = new Map<keyof KnownClients, Dispatcher>()

    const fake = createHttpClientFake(this.#config.clients, (restoration) => {
      if (this.#fake === fake) {
        for (const [clientName, dispatcher] of originalDispatchers) {
          clients[clientName]?.[httpClientDispatcher](dispatcher)
        }
        this.#fake = undefined
        this.#restoringFake = fake
        this.#fakeRestoration = restoration
        this.#clients = clients

        const clearRestoration = () => {
          if (this.#fakeRestoration === restoration) {
            this.#restoringFake = undefined
            this.#fakeRestoration = undefined
          }
        }
        void restoration.then(clearRestoration, clearRestoration)
      }
    })

    for (const [clientName, client] of Object.entries(clients) as [
      keyof KnownClients,
      HttpClient,
    ][]) {
      const dispatcher = fake[httpClientFakeDispatcher](
        String(clientName) as keyof KnownClients & string
      )
      originalDispatchers.set(clientName, client[httpClientDispatcher](dispatcher))
    }
    this.#fake = fake
    return fake
  }

  /** Restore the managed clients that were active before fake mode. */
  async restore(): Promise<void> {
    if (this.#fake) {
      await this.#fake.restore()
    } else {
      await this.#fakeRestoration
    }
  }

  request<
    Method extends HttpMethod,
    Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, Method>,
  >(
    method: Method,
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, Method, Path>
  ) {
    return this.use().request(method, path, ...options)
  }

  get<Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, 'GET'>>(
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, 'GET', Path>
  ) {
    return this.use().get(path, ...options)
  }

  post<Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, 'POST'>>(
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, 'POST', Path>
  ) {
    return this.use().post(path, ...options)
  }

  put<Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, 'PUT'>>(
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, 'PUT', Path>
  ) {
    return this.use().put(path, ...options)
  }

  patch<Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, 'PATCH'>>(
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, 'PATCH', Path>
  ) {
    return this.use().patch(path, ...options)
  }

  delete<Path extends ClientPath<InferClientApi<KnownClients[DefaultClient]>, 'DELETE'>>(
    path: Path,
    ...options: ClientRequestArguments<InferClientApi<KnownClients[DefaultClient]>, 'DELETE', Path>
  ) {
    return this.use().delete(path, ...options)
  }

  stream(path: string | URL, options?: StreamRequestOptions) {
    return this.use().stream(path, options)
  }

  async close(): Promise<void> {
    await this.restore()
    const clients = Object.values(this.#clients) as HttpClient[]
    this.#clients = {}
    await Promise.all(clients.map((client) => client.close()))
  }

  async destroy(error?: Error): Promise<void> {
    const fake = this.#fake ?? this.#restoringFake
    if (fake) {
      await fake.destroy(error)
    } else {
      await this.#fakeRestoration
    }
    const clients = Object.values(this.#clients) as HttpClient[]
    this.#clients = {}
    await Promise.all(clients.map((client) => client.destroy(error)))
  }
}
