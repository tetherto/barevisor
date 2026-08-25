const { Readable } = require('streamx')
const b4a = require('b4a')
const fetch = require('#fetch')

module.exports = class HttpDrive {
  constructor(base) {
    this.base = base
  }

  ready() {
    return Promise.resolve()
  }

  createReadStream(key) {
    const url = this.base + key
    let reader = null

    return new Readable({
      async open(cb) {
        const response = await fetch(url)

        if (!response.ok) {
          const err = new Error('Failed to fetch ' + key + ': ' + response.status)
          err.status = response.status
          return cb(err)
        }

        reader = response.body.getReader()
        cb(null)
      },
      async read(cb) {
        const { done, value } = await reader.read()

        this.push(done ? null : b4a.from(value))
        cb(null)
      },
      destroy(cb) {
        if (reader) reader.cancel().then(() => cb(null), cb)
        else cb(null)
      }
    })
  }

  async get(key) {
    const chunks = []

    try {
      for await (const chunk of this.createReadStream(key)) chunks.push(chunk)
    } catch (err) {
      if (err.status === 404) return null
      throw err
    }

    return b4a.concat(chunks)
  }
}
