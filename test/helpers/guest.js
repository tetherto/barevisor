const { Duplex } = require('streamx')
const VM = require('../../lib/vm')

// stands in for a VM so the drive logic can be tested without a hypervisor
// net and bare-net both take a write callback, plain streamx does not
class MockSocket extends Duplex {
  write(data, cb) {
    if (cb) queueMicrotask(cb)
    return super.write(data)
  }

  _write(data, cb) {
    cb(null)
  }
}

module.exports = class MockGuest {
  constructor(files = {}) {
    this.files = files
    this.commands = []
    this.guestReady = 'listening on'
  }

  guestAddress(port) {
    return 'VSOCK-LISTEN:' + port + ',reuseaddr'
  }

  ready() {
    return Promise.resolve()
  }

  exec(command) {
    this.commands.push(command)

    const stat = command.match(/^stat -c %s '(.+)'$/)
    if (stat) {
      const data = this.files[stat[1]]
      return Promise.resolve(
        data === undefined
          ? { exitCode: 1, stdout: '', stderr: 'No such file' }
          : { exitCode: 0, stdout: data.length + '\n', stderr: '' }
      )
    }

    if (command.startsWith('cd ')) {
      const keys = Object.keys(this.files).map((path) => '.' + path.slice(path.lastIndexOf('/')))
      return Promise.resolve({ exitCode: 0, stdout: keys.join('\n') + '\n', stderr: '' })
    }

    if (command.includes('socat')) {
      return Promise.resolve({ exitCode: 0, stdout: '123\n', stderr: '' })
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  }

  // the real implementation, so the mock cannot drift from it
  listen(port, address, opts) {
    return VM.prototype.listen.call(this, port, address, opts)
  }

  connect() {
    const socket = new MockSocket()

    queueMicrotask(() => socket.emit('connect'))

    return socket
  }
}
