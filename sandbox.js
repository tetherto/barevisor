const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')
const Localdrive = require('localdrive')
const quote = require('./lib/shell-quote')
const Linux = require('./')
const SandboxImage = require('./lib/image/sandbox')
const PortPool = require('./lib/port-pool')
const StreamDrive = require('./lib/stream-drive')

module.exports = class Sandbox extends Linux {
  constructor(opts = {}) {
    const dir = opts.dir || path.join(os.tmpdir(), 'linux-sandbox-' + process.pid)
    const image = opts.image || new SandboxImage(opts)
    const disk = opts.disk ?? true
    const transfers = disk ? [] : ports(image.agentPort + 1, opts.transfers ?? 4)

    super({
      ...opts,
      dir,
      image,
      ports: [...(opts.ports || []), ...transfers],
      mounts: disk
        ? {
            ...opts.mounts,
            [image.workspace + '/in']: { path: path.join(dir, 'in'), readonly: true },
            [image.workspace + '/out']: { path: path.join(dir, 'out') }
          }
        : opts.mounts
    })

    this.disk = disk
    this.staging = disk ? dir : null
    this.pool = new PortPool(transfers)

    if (disk) {
      this.in = new Localdrive(path.join(dir, 'in'))
      this.out = new Localdrive(path.join(dir, 'out'))
    } else {
      this.in = new StreamDrive(this, image.workspace + '/in', { pool: this.pool })
      this.out = new StreamDrive(this, image.workspace + '/out', { pool: this.pool })
    }

    this.offline = opts.offline ?? false
    this.env = { NODE_PATH: '/usr/local/lib/node_modules', ...opts.env }
    this.cpuTime = opts.cpuTime || 30
    this.maxFileSize = opts.maxFileSize || 64 * 1024 * 1024
    this.maxProcesses = opts.maxProcesses || 64
  }

  static pip(packages, opts) {
    return SandboxImage.pip(packages, opts)
  }

  static npm(packages, opts) {
    return SandboxImage.npm(packages, opts)
  }

  async run(command, opts = {}) {
    await this.ready()

    const { user, workspace } = this.image
    const env = { ...this.env, ...opts.env }
    const timeout = opts.timeout ?? this.cpuTime

    const script = [
      'set -e',
      'cd ' + workspace + '/out',
      ...Object.entries(env).map(([key, value]) => `export ${key}=${quote(String(value))}`),
      `ulimit -t ${this.cpuTime} -f ${Math.ceil(this.maxFileSize / 512)} -u ${this.maxProcesses}`,
      `exec timeout ${timeout} ${command}`
    ].join('\n')

    try {
      return await this.exec(`su -s /bin/sh ${user} -c ${quote(script)}`)
    } finally {
      await this._reap()
    }
  }

  _reap() {
    const uid = this.image.uid

    return this.exec(
      `for d in /proc/[0-9]*; do [ "$(awk '/^Uid:/{print $2}' $d/status 2>/dev/null)" = "${uid}" ] && kill -9 "\${d#/proc/}" 2>/dev/null; done; true`
    )
  }

  async _open() {
    if (this.disk) {
      await fs.promises.mkdir(path.join(this.staging, 'in'), { recursive: true })
      await fs.promises.mkdir(path.join(this.staging, 'out'), { recursive: true })
      await fs.promises.chmod(path.join(this.staging, 'out'), 0o777)
    }

    await super._open()

    if (this.offline) await this._rpc().exec('ip link set eth0 down && ip route flush all')
  }

  async _close() {
    await super._close()
    if (this.disk) await fs.promises.rm(this.staging, { recursive: true, force: true })
  }
}

function ports(base, count) {
  const ports = []
  for (let i = 0; i < count; i++) ports.push(base + i)
  return ports
}
