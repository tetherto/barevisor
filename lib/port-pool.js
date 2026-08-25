module.exports = class PortPool {
  constructor(ports) {
    this.ports = ports

    this._free = [...ports]
    this._waiting = []
  }

  acquire() {
    if (this._free.length > 0) return Promise.resolve(this._free.pop())

    return new Promise((resolve) => this._waiting.push(resolve))
  }

  release(port) {
    const next = this._waiting.shift()

    if (next) next(port)
    else this._free.push(port)
  }
}
