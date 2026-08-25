module.exports = class AgentClient {
  constructor(socket) {
    this.socket = socket

    this._id = 0
    this._pending = new Map()
    this._buffer = ''
    this._error = null

    socket.on('data', (data) => this._ondata(data))
    socket.on('error', (err) => this._destroy(err))
    socket.on('close', () => this._destroy(new Error('Agent socket closed')))
  }

  ping() {
    return this._request('ping')
  }

  exec(command, opts = {}) {
    return this._request('exec', { command, ...opts })
  }

  close() {
    this.socket.destroy()
  }

  _request(method, params) {
    if (this._error) return Promise.reject(this._error)

    const id = ++this._id

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this.socket.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  _ondata(data) {
    this._buffer += data.toString()

    let index
    while ((index = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, index)
      this._buffer = this._buffer.slice(index + 1)
      this._onmessage(JSON.parse(line))
    }
  }

  _onmessage(message) {
    const request = this._pending.get(message.id)
    if (!request) return

    this._pending.delete(message.id)

    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.result)
  }

  _destroy(err) {
    this._error = err

    for (const request of this._pending.values()) request.reject(err)
    this._pending.clear()
  }
}
