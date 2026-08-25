const ReadyResource = require('ready-resource')
const AgentClient = require('./agent-client')
const Listener = require('./listener')
const mountTags = require('./mount-tags')
const Image = require('../image')

const PING_TIMEOUT = 2000

module.exports = class VM extends ReadyResource {
  constructor(opts = {}) {
    super()

    this.image = Image.from(opts.image)
    this.cpus = opts.cpus || 1
    this.memory = parseMemory(opts.memory || '1gb')
    this.mounts = normalize(opts.mounts || {})
    this.ports = opts.ports || []
    this.debug = opts.debug ?? false

    this.network = opts.network ?? this.image.network
    this.agent = opts.agent ?? this.image.agent
    this.agentPort = opts.agentPort ?? this.image.agentPort
    this.timeout = opts.timeout ?? this.image.timeout

    this.mountType = 'virtiofs'
    this.mountOptions = ''

    this.image.transport = this.transport

    this._client = null
    this._failed = null
  }

  get transport() {
    return 'vsock'
  }

  // the guest side of a host-initiated connection, as a socat address
  guestAddress(port) {
    return 'VSOCK-LISTEN:' + port + ',reuseaddr'
  }

  // what socat logs once the address above is ready to be dialed, or null when
  // the backend queues host writes until the guest is listening
  get guestReady() {
    return 'listening on'
  }

  // whether the host has to be connected before the guest opens its end
  get dialsFirst() {
    return false
  }

  connect(port) {
    return this._connect(port)
  }

  async listen(port, address, opts) {
    const listener = new Listener(this, port, address, opts)
    await listener.ready()

    return listener
  }

  async exec(command, opts) {
    await this.ready()
    return this._rpc().exec(command, opts)
  }

  async _open() {
    await this.image.ready()
    await this._start()
    if (!this.agent) return
    await this._waitForAgent()
    await this._mountAll()
  }

  async _close() {
    this._reset()
    await this._stop()
  }

  _rpc() {
    if (!this._client) this._client = new AgentClient(this._connect(this.agentPort))
    return this._client
  }

  _reset() {
    if (this._client) this._client.close()
    this._client = null
  }

  async _waitForAgent() {
    const deadline = Date.now() + this.timeout

    while (true) {
      const client = this._rpc()

      try {
        await ping(client)
        return
      } catch {
        // a backend that accepts the socket before the guest is listening never
        // fails the ping, so it is bounded per attempt. The connection is only
        // dropped once it is really broken — redialing a live one makes the
        // guest listener exit and restart, and the two ends never line up.
        if (client.closed) this._reset()
        if (this.closing) throw new Error('VM closed while booting')
        if (this._failed) throw this._failed
        if (Date.now() > deadline) throw new Error('Timed out waiting for guest agent')
        await sleep(250)
      }
    }
  }

  async _mountAll() {
    for (const [guest, tag] of mountTags(this.mounts)) {
      const flags = mountFlags(this.mountOptions, this.mounts[guest].readonly)

      await this._rpc().exec(
        `mkdir -p "${guest}" && mount -t ${this.mountType} ${flags} ${tag} "${guest}"`
      )
    }
  }
}

function ping(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent ping timed out')), PING_TIMEOUT)

    client.ping().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function mountFlags(options, readonly) {
  const flags = options ? options.split(',') : []
  if (readonly) flags.push('ro')

  return flags.length ? '-o ' + flags.join(',') : ''
}

function normalize(mounts) {
  const normalized = {}

  for (const [guest, mount] of Object.entries(mounts)) {
    normalized[guest] = typeof mount === 'string' ? { path: mount, readonly: false } : mount
  }

  return normalized
}

function parseMemory(memory) {
  if (typeof memory === 'number') return memory

  const match = memory.toLowerCase().match(/^(\d+)\s*(gb?|mb?)?$/)
  if (!match) throw new Error('Invalid memory: ' + memory)

  const n = Number(match[1])
  return match[2] && match[2][0] === 'g' ? n * 1024 : n
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
