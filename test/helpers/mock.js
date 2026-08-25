const net = require('net')
const process = require('process')
const serve = require('../../agent')
const socketPath = require('./socket')
const VM = require('../../lib/vm')

let mocks = 0

module.exports = class MockVM extends VM {
  constructor(opts = {}) {
    super(opts)

    this.socket = socketPath('barevisor-mock-' + process.pid + '-' + mocks++)
    this.server = null
    this.connections = new Set()
  }

  _connect() {
    return net.connect(this.socket)
  }

  async _start() {
    this.server = serve(this.socket)
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
  }
}
