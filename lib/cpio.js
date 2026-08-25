const b4a = require('b4a')

// newc (SVR4) cpio, the initramfs format — append the result to a stock
// initramfs to overlay files onto it

module.exports = function cpio(entries) {
  const chunks = []
  let ino = 1

  for (const { name, data = null, mode = data ? 0o100644 : 0o40755 } of entries) {
    chunks.push(entry(ino++, name.replace(/^\/+/, ''), mode, data))
  }

  chunks.push(entry(0, 'TRAILER!!!', 0, null))

  return b4a.concat(chunks)
}

function entry(ino, name, mode, data) {
  const size = data ? data.length : 0

  const header =
    '070701' +
    hex(ino) +
    hex(mode) +
    hex(0) + // uid
    hex(0) + // gid
    hex(1) + // nlink
    hex(0) + // mtime
    hex(size) +
    hex(0) + // devmajor
    hex(0) + // devminor
    hex(0) + // rdevmajor
    hex(0) + // rdevminor
    hex(name.length + 1) +
    hex(0) // check

  const head = b4a.from(header + name + '\0')
  const parts = [head, pad(head.length)]

  if (data) parts.push(data, pad(size))

  return b4a.concat(parts)
}

function hex(n) {
  return n.toString(16).padStart(8, '0')
}

function pad(length) {
  return b4a.alloc((4 - (length % 4)) % 4)
}
