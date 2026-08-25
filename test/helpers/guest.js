const { Duplex } = require('streamx')

// stands in for a VM so the drive logic can be tested without a hypervisor
module.exports = class MockGuest {
  constructor(files = {}) {
    this.files = files
    this.commands = []
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

  connect() {
    const socket = new Duplex({
      write(data, cb) {
        cb(null)
      }
    })

    queueMicrotask(() => socket.emit('connect'))

    return socket
  }
}
