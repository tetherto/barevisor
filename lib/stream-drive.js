const { Readable, Writable } = require('streamx')
const b4a = require('b4a')
const quote = require('./shell-quote')

// A drive over a guest directory, moved across vm.connect() so the contents are
// never shared with the host filesystem.
//
// vfkit never propagates a socket close into the guest, so neither side can
// rely on EOF to end a transfer. Both directions are bounded by an explicit
// byte count instead: reads take it from the file, writes from the payload.
module.exports = class StreamDrive {
  constructor(vm, root, opts = {}) {
    this.vm = vm
    this.root = root
    this.pool = opts.pool
  }

  ready() {
    return this.vm.ready()
  }

  createReadStream(key) {
    const drive = this
    let transfer = null
    let remaining = 0

    return new Readable({
      async open(cb) {
        try {
          const entry = await drive.entry(key)
          if (entry === null) return cb(new Error('Not found: ' + key))

          remaining = entry.value.blob.byteLength
          if (remaining === 0) {
            this.push(null)
            return cb(null)
          }

          transfer = await drive._open(`OPEN:${quote(drive._path(key))},rdonly`, false)
        } catch (err) {
          return cb(err)
        }

        transfer.socket.on('data', (data) => {
          const chunk = data.length > remaining ? data.subarray(0, remaining) : data

          remaining -= chunk.length

          if (this.push(chunk) === false) transfer.socket.pause()
          if (remaining === 0) this.push(null)
        })
        transfer.socket.on('error', (err) => this.destroy(err))

        cb(null)
      },
      read(cb) {
        if (transfer) transfer.socket.resume()
        cb(null)
      },
      destroy(cb) {
        if (transfer) transfer.close().then(() => cb(null), cb)
        else cb(null)
      }
    })
  }

  // the guest reader needs the length up front, so the payload is collected
  // before it is sent
  createWriteStream(key) {
    const drive = this
    const chunks = []

    return new Writable({
      write(data, cb) {
        chunks.push(data)
        cb(null)
      },
      final(cb) {
        drive.put(key, b4a.concat(chunks)).then(() => cb(null), cb)
      }
    })
  }

  async entry(key) {
    const { exitCode, stdout } = await this.vm.exec(`stat -c %s ${quote(this._path(key))}`)
    if (exitCode !== 0) return null

    return { key, value: { blob: { byteLength: Number(stdout.trim()) } } }
  }

  async get(key) {
    const chunks = []

    for await (const chunk of this.createReadStream(key)) chunks.push(chunk)

    return b4a.concat(chunks)
  }

  async put(key, data) {
    const path = this._path(key)

    await this.vm.exec(`mkdir -p ${quote(dirname(path))}`)

    const transfer = await this._open(quote(`SYSTEM:head -c ${data.length} > ${quote(path)}`), true)

    try {
      await new Promise((resolve, reject) => {
        transfer.socket.on('error', reject)
        transfer.socket.write(data, resolve)
      })

      await transfer.finished()
    } finally {
      await transfer.close()
    }
  }

  async del(key) {
    await this.vm.exec(`rm -f ${quote(this._path(key))}`)
  }

  async *list() {
    const { stdout } = await this.vm.exec(`cd ${quote(this.root)} && find . -type f`)

    for (const line of stdout.split('\n')) {
      if (line) yield { key: line.slice(1) }
    }
  }

  _path(key) {
    return this.root + (key[0] === '/' ? key : '/' + key)
  }

  async _open(address, writing) {
    const port = await this.pool.acquire()

    let listener = null
    try {
      listener = await this.vm.listen(port, address, { writing })

      const socket = await listener.connect()

      return {
        socket,
        finished: () => listener.finished(),
        close: () => this._close(listener, socket)
      }
    } catch (err) {
      if (listener) await listener.close()
      this.pool.release(port)
      throw err
    }
  }

  async _close(listener, socket) {
    socket.destroy()
    await listener.close()
    this.pool.release(listener.port)
  }
}

function dirname(path) {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
