const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')
const zlib = require('zlib')
const ReadyResource = require('ready-resource')
const { Readable, pipelinePromise } = require('streamx')
const cpio = require('../cpio')
const zboot = require('../zboot')

const AGENT = path.join(__dirname, '..', '..', 'agent')

let stores = 0

module.exports = class Image extends ReadyResource {
  constructor(drive, opts = {}) {
    super()

    this.drive = drive || null
    this.name = opts.name || 'image'
    this.cache = opts.cache || path.join(os.homedir(), '.cache', 'linux')
    this.keys = { kernel: '/vmlinuz', initrd: '/initramfs', ...opts.keys }

    this.kernel = opts.kernel || null
    this.initrd = opts.initrd || null
    this.disk = opts.disk || null
    this.cmdline = opts.cmdline || 'console=hvc0'

    this.agent = opts.agent ?? true
    this.agentPort = opts.agentPort ?? 5555
    this.network = opts.network ?? false
    this.timeout = opts.timeout ?? 30000
  }

  static from(image) {
    return image instanceof Image ? image : new Image(null, image)
  }

  get dir() {
    return path.join(this.cache, this.name)
  }

  async overlay() {
    return [
      { name: 'agent' },
      { name: 'agent/index.js', data: await fs.promises.readFile(path.join(AGENT, 'index.js')) },
      { name: 'agent/run.js', data: await fs.promises.readFile(path.join(AGENT, 'run.js')) }
    ]
  }

  async _open() {
    if (!this.drive) return

    await this.drive.ready()
    await fs.promises.mkdir(this.dir, { recursive: true })

    this.kernel = await this._kernel()
    this.initrd = await this._initrd()
  }

  async _kernel() {
    const dest = path.join(this.dir, 'vmlinuz')
    if (await exists(dest)) return dest

    const packed = await this._store(
      dest + '.zboot.' + stores++,
      this.drive.createReadStream(this.keys.kernel)
    )
    const range = await zboot(packed)

    if (range === null) {
      await fs.promises.rename(packed, dest)
      return dest
    }

    const wrapped = fs.createReadStream(packed, {
      start: range.offset,
      end: range.offset + range.size - 1
    })

    await this._store(dest, wrapped.pipe(zlib.createGunzip()))
    await fs.promises.unlink(packed)

    return dest
  }

  async _initrd() {
    const base = path.join(this.dir, 'initramfs')
    if (!(await exists(base))) {
      await this._store(base, this.drive.createReadStream(this.keys.initrd))
    }

    if (!this.agent) return base

    const overlay = zlib.gzipSync(cpio(await this.overlay()))
    const dest = path.join(this.dir, 'initramfs-' + digest(overlay))
    if (await exists(dest)) return dest

    return this._store(dest, append(fs.createReadStream(base), overlay))
  }

  async _store(dest, stream) {
    const tmp = dest + '.' + process.pid + '.' + stores++

    await pipelinePromise(stream, fs.createWriteStream(tmp))
    await fs.promises.rename(tmp, dest)

    return dest
  }
}

function append(stream, tail) {
  return Readable.from(
    (async function* () {
      for await (const chunk of stream) yield chunk
      yield tail
    })()
  )
}

async function exists(file) {
  try {
    await fs.promises.stat(file)
    return true
  } catch {
    return false
  }
}

function digest(buf) {
  let hash = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) hash = Math.imul(hash ^ buf[i], 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
