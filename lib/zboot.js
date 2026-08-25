const fs = require('fs')
const b4a = require('b4a')

// arm64 kernels ship as EFI zboot: a PE wrapper around a gzipped Image.
// Virtualization.framework needs the raw Image
module.exports = async function zboot(file) {
  const handle = await fs.promises.open(file)

  try {
    const head = b4a.alloc(16)
    await handle.read(head, 0, head.length, 0)

    if (b4a.toString(head.subarray(4, 8)) !== 'zimg') return null

    const header = new DataView(head.buffer, head.byteOffset, head.byteLength)

    return { offset: header.getUint32(8, true), size: header.getUint32(12, true) }
  } finally {
    await handle.close()
  }
}
