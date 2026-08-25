const { Readable } = require('streamx')
const b4a = require('b4a')

module.exports = class MockDrive {
  constructor(entries) {
    this.entries = entries
    this.reads = []
  }

  ready() {
    return Promise.resolve()
  }

  createReadStream(key) {
    this.reads.push(key)

    const data = this.entries[key]
    if (data === undefined) return Readable.from([])

    return Readable.from([b4a.from(data)])
  }

  get(key) {
    const data = this.entries[key]
    return Promise.resolve(data === undefined ? null : b4a.from(data))
  }
}
