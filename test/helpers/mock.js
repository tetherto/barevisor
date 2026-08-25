const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const serve = require('../../agent')
const VM = require('../../lib/vm')

module.exports = class MockVM extends VM {
  constructor(opts = {}) {
    super(opts)

    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barevisor-mock-'))
    this.server = null
    this.connections = new Set()
  }

  _connect() {
    return net.connect(path.join(this.dir, 'agent.sock'))
  }

  async _start() {
    this.server = serve(path.join(this.dir, 'agent.sock'))
    this.server.on('connection', (socket) => {
      this.connections.add(socket)
      socket.on('close', () => this.connections.delete(socket))
    })
    await new Promise((resolve) => this.server.on('listening', resolve))
  }

  async _stop() {
    const closed = new Promise((resolve) => this.server.close(resolve))
    for (const socket of this.connections) socket.destroy()
    await closed
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
