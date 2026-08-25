const fs = require('fs')
const b4a = require('b4a')

const LIMIT = 4096

// a hypervisor that rejects its own arguments exits before the guest ever
// boots, so surface what it said instead of timing out on the agent
module.exports = function exited(name, code, log) {
  const detail = read(log)
  const message = name + ' exited with code ' + code

  return new Error(detail ? message + ': ' + detail : message)
}

function read(log) {
  let handle = null

  try {
    handle = fs.openSync(log, 'r')
  } catch {
    return null
  }

  try {
    const size = fs.fstatSync(handle).size
    const length = Math.min(size, LIMIT)
    const chunk = b4a.alloc(length)

    fs.readSync(handle, chunk, 0, length, size - length)

    return b4a.toString(chunk).trim()
  } finally {
    fs.closeSync(handle)
  }
}
