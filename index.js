const Driver = require('#driver')
const Alpine = require('./lib/image/alpine')

module.exports = class Barevisor extends Driver {
  constructor(opts = {}) {
    super({ ...opts, image: opts.image || new Alpine(opts) })
  }
}
