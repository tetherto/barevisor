const fs = require('fs')
const process = require('process')
const b4a = require('b4a')

// hypervisors write the guest console to a file, so debug mode follows it
module.exports = function tail(file) {
  let offset = 0

  return setInterval(() => {
    let handle = null

    try {
      handle = fs.openSync(file, 'r')
    } catch {
      return // the guest has not opened the console yet
    }

    try {
      const size = fs.fstatSync(handle).size
      if (size <= offset) return

      const chunk = b4a.alloc(size - offset)
      fs.readSync(handle, chunk, 0, chunk.length, offset)
      offset = size

      process.stdout.write(chunk)
    } finally {
      fs.closeSync(handle)
    }
  }, 200).unref()
}
