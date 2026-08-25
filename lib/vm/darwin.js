const { spawn } = require('child_process')
const fs = require('fs')
const process = require('process')
const b4a = require('b4a')
const net = require('net')
const os = require('os')
const path = require('path')
const mountTags = require('./mount-tags')
const VM = require('./')

module.exports = class DarwinVM extends VM {
  constructor(opts = {}) {
    super(opts)

    this.vfkit = opts.vfkit || 'vfkit'
    this.dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vm-'))
    this.process = null

    this._exited = null
    this._tail = null
  }

  get console() {
    return path.join(this.dir, 'console.log')
  }

  _logs() {
    return [
      'ignore',
      fs.openSync(path.join(this.dir, 'stdout.log'), 'a'),
      fs.openSync(path.join(this.dir, 'stderr.log'), 'a')
    ]
  }

  _socketPath(port) {
    return path.join(this.dir, 'vsock-' + port + '.sock')
  }

  _connect(port) {
    return net.connect(this._socketPath(port))
  }

  async _start() {
    if (!this.image.kernel && !this.image.disk) {
      throw new Error('No image configured, pass opts.image')
    }

    const stdio = this.debug ? null : this._logs()

    let child
    try {
      child = spawn(this.vfkit, this._args(), { stdio: stdio || 'inherit' })
    } catch (err) {
      throw vfkitError(err) // bare-subprocess throws synchronously
    } finally {
      if (stdio) for (const fd of stdio.slice(1)) fs.closeSync(fd)
    }

    this.process = child
    this._exited = new Promise((resolve) => child.on('exit', resolve))

    if (this.debug) this._tail = tail(this.console)

    if (!child.pid) {
      await new Promise((resolve, reject) => {
        child.on('spawn', resolve)
        child.on('error', (err) => reject(vfkitError(err)))
      })
    }
  }

  async _stop() {
    if (this._tail) clearInterval(this._tail)

    const child = this.process
    if (!child) return

    kill(child, 'SIGTERM')

    const timeout = setTimeout(() => kill(child, 'SIGKILL'), 5000)
    await this._exited
    clearTimeout(timeout)
  }

  _args() {
    const args = ['--cpus', String(this.cpus), '--memory', String(this.memory)]

    const { kernel, initrd, cmdline, disk } = this.image

    if (kernel) {
      let bootloader = 'linux,kernel=' + kernel
      if (initrd) bootloader += ',initrd=' + initrd
      if (cmdline) bootloader += ',cmdline="' + cmdline + '"'
      args.push('--bootloader', bootloader)
    } else {
      args.push(
        '--bootloader',
        'efi,variable-store=' + path.join(this.dir, 'efi-store') + ',create'
      )
    }

    if (disk) args.push('--device', 'virtio-blk,path=' + disk)
    if (this.network) args.push('--device', 'virtio-net,nat')

    for (const [guest, tag] of mountTags(this.mounts)) {
      args.push('--device', 'virtio-fs,sharedDir=' + this.mounts[guest].path + ',mountTag=' + tag)
    }

    const ports = this.agent ? [this.agentPort, ...this.ports] : this.ports
    for (const port of ports) {
      // connect = host-initiated: vfkit listens on the unix socket and dials the guest port
      args.push(
        '--device',
        'virtio-vsock,port=' + port + ',socketURL=' + this._socketPath(port) + ',connect'
      )
    }

    args.push('--device', 'virtio-serial,logFilePath=' + this.console)
    args.push('--device', 'virtio-rng')

    return args
  }
}

// vfkit can only write the guest console to a file, so debug mode follows it
function tail(file) {
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

function kill(child, signal) {
  try {
    child.kill(signal)
  } catch {} // already exited
}

function vfkitError(err) {
  return err.code === 'ENOENT'
    ? new Error('vfkit not found, install it with `brew install vfkit`')
    : err
}
