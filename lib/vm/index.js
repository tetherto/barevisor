const ReadyResource = require('ready-resource')
const AgentClient = require('./agent-client')
const mountTags = require('./mount-tags')
const Image = require('../image')

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

    this._client = null
  }

  connect(port) {
    return this._connect(port)
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
    if (this._client) this._client.close()
    this._client = null
    await this._stop()
  }

  _rpc() {
    if (!this._client) this._client = new AgentClient(this._connect(this.agentPort))
    return this._client
  }

  async _waitForAgent() {
    const deadline = Date.now() + this.timeout

    while (true) {
      try {
        await this._rpc().ping()
        return
      } catch {
        this._client = null
        if (this.closing) throw new Error('VM closed while booting')
        if (Date.now() > deadline) throw new Error('Timed out waiting for guest agent')
        await sleep(250)
      }
    }
  }

  async _mountAll() {
    for (const [guest, tag] of mountTags(this.mounts)) {
      const flags = this.mounts[guest].readonly ? '-o ro' : ''

      await this._rpc().exec(`mkdir -p "${guest}" && mount -t virtiofs ${flags} ${tag} "${guest}"`)
    }
  }
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
