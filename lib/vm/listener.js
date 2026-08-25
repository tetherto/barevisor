const ReadyResource = require('ready-resource')

const LOG = '/run/port.'

// The guest end of vm.connect(): a socat listener on `port` wired to a socat
// address, started over the agent and reaped on close.
module.exports = class Listener extends ReadyResource {
  constructor(vm, port, address, opts = {}) {
    super()

    this.vm = vm
    this.port = port
    this.address = address
    this.writing = opts.writing ?? false
    this.pid = 0
  }

  async connect() {
    let last = null

    for (let i = 0; i < 200; i++) {
      const socket = this.vm.connect(this.port)

      try {
        await new Promise((resolve, reject) => {
          socket.on('connect', resolve)
          socket.on('error', reject)
        })

        return socket
      } catch (err) {
        last = err
        socket.destroy()
        await sleep(25)
      }
    }

    throw last
  }

  finished() {
    return this.vm.exec(`while kill -0 ${this.pid} 2>/dev/null; do sleep 0.02; done; true`)
  }

  async _open() {
    const started = await this.vm.exec(script(this))

    this.pid = Number(started.stdout.trim())
  }

  // the caller cannot reuse the port until the guest listener is gone, or the
  // next dial would land on this one
  _close() {
    return this.vm.exec(
      `kill -9 ${this.pid} 2>/dev/null
       while kill -0 ${this.pid} 2>/dev/null; do sleep 0.02; done
       rm -f ${LOG}${this.port}
       true`
    )
  }
}

// both backends accept on the host socket whether or not the guest is
// listening, but only vfkit drops what is written before it is, so there the
// listener has to be confirmed bound before it is dialed
function script(listener) {
  const { vm, port, address, writing } = listener

  const start = `socat -d -d ${writing ? '-u' : '-U'} ${vm.guestAddress(port)} ${address} >/dev/null 2>${LOG}${port} </dev/null &
pid=$!`

  if (vm.guestReady === null) return start + '\necho $pid'

  return `${start}
for i in $(seq 1000); do
  grep -q '${vm.guestReady}' ${LOG}${port} && break
  kill -0 $pid 2>/dev/null || break
  sleep 0.01
done
echo $pid`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
