const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const process = require('process')
const exited = require('./exited')
const logs = require('./logs')
const mountTags = require('./mount-tags')
const tail = require('./tail')
const which = require('./which')
const VM = require('./')

const ARCHS = { arm64: 'aarch64', x64: 'x86_64' }
const MACHINES = { aarch64: 'virt', x86_64: 'q35' }
const PACKAGES = { aarch64: 'qemu-system-arm', x86_64: 'qemu-system-x86' }

const FIRMWARE = {
  aarch64: ['/usr/share/AAVMF/AAVMF_CODE.fd', '/usr/share/qemu/edk2-aarch64-code.fd'],
  x86_64: [
    '/usr/share/OVMF/OVMF_CODE.fd',
    '/usr/share/edk2/ovmf/OVMF_CODE.fd',
    '/usr/share/qemu/edk2-x86_64-code.fd'
  ]
}

const VIRTIOFSD = ['virtiofsd', '/usr/libexec/virtiofsd', '/usr/lib/qemu/virtiofsd']
const MOUNT_9P = 'trans=virtio,version=9p2000.L,msize=512000,cache=loose'

let warned = false

module.exports = class LinuxVM extends VM {
  constructor(opts = {}) {
    super(opts)

    this.arch = opts.arch || ARCHS[os.arch()]
    this.qemu = opts.qemu || process.env.LINUX_QEMU || null
    this.accel = opts.accel || null
    this.virtiofsd = opts.virtiofsd || null
    this.datadir = opts.datadir || process.env.LINUX_QEMU_DATADIR || null
    this.dir = opts.dir ? ensure(opts.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'barevisor-vm-'))
    this.process = null

    this._exited = null
    this._tail = null
    this._helpers = []
  }

  // qemu cannot bridge guest vsock to a host unix socket, so each port is a
  // virtio-serial port instead
  get transport() {
    return 'vport'
  }

  guestAddress(port) {
    return 'GOPEN:$(/agent/vport ' + name(port) + ')'
  }

  // qemu stops reading the host socket until the guest opens the port, so a
  // dial never races the listener
  get guestReady() {
    return null
  }

  // a guest that opens a port with nothing connected to it reads EOF and gives
  // up, so the host has to be there first
  get dialsFirst() {
    return true
  }

  get console() {
    return path.join(this.dir, 'console.log')
  }

  _socketPath(port) {
    return path.join(this.dir, 'port-' + port + '.sock')
  }

  _sharePath(tag) {
    return path.join(this.dir, 'virtiofs-' + tag + '.sock')
  }

  _connect(port) {
    return net.connect(this._socketPath(port))
  }

  async _start() {
    if (!this.image.kernel && !this.image.disk) {
      throw new Error('No image configured, pass opts.image')
    }

    if (!this.qemu) this.qemu = locate(this.arch)
    if (!this.accel) this.accel = accel()

    await this._share()

    const stdio = this.debug ? null : logs(this.dir)

    let child
    try {
      child = spawn(this.qemu, this._args(), { stdio: stdio || 'inherit' })
    } finally {
      if (stdio) for (const fd of stdio.slice(1)) fs.closeSync(fd)
    }

    this.process = child
    this._exited = new Promise((resolve) => child.on('exit', resolve))

    child.on('exit', (code) => {
      this._failed = exited(path.basename(this.qemu), code, path.join(this.dir, 'stderr.log'))
    })

    if (this.debug) this._tail = tail(this.console)

    if (!child.pid) {
      await new Promise((resolve, reject) => {
        child.on('spawn', resolve)
        child.on('error', reject)
      })
    }
  }

  async _stop() {
    if (this._tail) clearInterval(this._tail)

    const helpers = this._helpers
    this._helpers = []

    const child = this.process

    if (child) {
      kill(child, 'SIGTERM')

      const timeout = setTimeout(() => kill(child, 'SIGKILL'), 5000)
      await this._exited
      clearTimeout(timeout)
    }

    for (const helper of helpers) kill(helper, 'SIGKILL')
  }

  // virtiofs matches what the guest mounts on macOS but needs a helper daemon,
  // so 9p is the fallback when it is not installed
  async _share() {
    const tags = mountTags(this.mounts)
    if (tags.length === 0) return

    if (!this.virtiofsd) this.virtiofsd = which(VIRTIOFSD)

    if (!this.virtiofsd) {
      this.mountType = '9p'
      this.mountOptions = MOUNT_9P
      return
    }

    for (const [guest, tag] of tags) {
      const socket = this._sharePath(tag)

      this._helpers.push(
        spawn(
          this.virtiofsd,
          ['--socket-path=' + socket, '--shared-dir=' + this.mounts[guest].path, '--sandbox=none'],
          { stdio: 'ignore' }
        )
      )

      await listening(socket)
    }
  }

  _args() {
    const { kernel, initrd, cmdline, disk } = this.image

    const shares = mountTags(this.mounts)
    const virtiofs = shares.length > 0 && this.mountType === 'virtiofs'

    const machine = [MACHINES[this.arch]]
    if (virtiofs) machine.push('memory-backend=mem')

    const args = [
      '-no-user-config',
      '-nodefaults',
      '-display',
      'none',
      '-no-reboot',
      '-machine',
      machine.join(','),
      '-accel',
      this.accel,
      // host only resolves under kvm, and virt boots a 32-bit core under tcg
      // unless it is told otherwise
      '-cpu',
      this.accel === 'kvm' ? 'host' : 'max',
      '-smp',
      String(this.cpus),
      '-m',
      String(this.memory)
    ]

    if (this.datadir) args.push('-L', this.datadir)

    if (virtiofs) {
      args.push('-object', 'memory-backend-memfd,id=mem,size=' + this.memory + 'M,share=on')
    }

    if (kernel) {
      args.push('-kernel', kernel)
      if (initrd) args.push('-initrd', initrd)
      if (cmdline) args.push('-append', cmdline)
    } else {
      args.push('-bios', firmware(this.arch))
    }

    if (disk) {
      args.push('-drive', 'if=none,id=disk0,format=raw,file=' + disk)
      args.push('-device', 'virtio-blk-pci,drive=disk0')
    }

    if (this.network) {
      args.push('-netdev', 'user,id=net0')
      args.push('-device', 'virtio-net-pci,netdev=net0')
    }

    const ports = this.agent ? [this.agentPort, ...this.ports] : this.ports

    args.push('-device', 'virtio-serial-pci,id=vs0,max_ports=' + (ports.length + 1))
    args.push('-chardev', 'file,id=con0,path=' + this.console + ',append=on')
    // the console has to claim port 0 or hvc0 takes whichever id is free
    args.push('-device', 'virtconsole,bus=vs0.0,chardev=con0,nr=0')

    let nr = 1
    for (const port of ports) {
      // wait=off or qemu blocks its own startup until the host dials in
      args.push(
        '-chardev',
        'socket,id=p' + port + ',path=' + this._socketPath(port) + ',server=on,wait=off'
      )
      // nr= because the device node the guest sees is not ordered by the
      // command line
      args.push(
        '-device',
        'virtserialport,bus=vs0.0,chardev=p' + port + ',nr=' + nr++ + ',name=' + name(port)
      )
    }

    for (const [guest, tag] of shares) {
      const { path: host, readonly } = this.mounts[guest]

      if (virtiofs) {
        args.push('-chardev', 'socket,id=fs' + tag + ',path=' + this._sharePath(tag))
        args.push('-device', 'vhost-user-fs-pci,chardev=fs' + tag + ',tag=' + tag)
        continue
      }

      const fsdev = [
        'local',
        'id=fs' + tag,
        'path=' + host,
        // the only unprivileged security model, passthrough needs root
        'security_model=none',
        'multidevs=remap'
      ]
      if (readonly) fsdev.push('readonly=on')

      args.push('-fsdev', fsdev.join(','))
      args.push('-device', 'virtio-9p-pci,fsdev=fs' + tag + ',mount_tag=' + tag)
    }

    args.push('-device', 'virtio-rng-pci')

    return args
  }
}

function name(port) {
  return 'port-' + port
}

function locate(arch) {
  const qemu = which(['qemu-system-' + arch, '/usr/libexec/qemu-kvm', '/usr/bin/qemu-kvm'])
  if (qemu) return qemu

  const env = sandbox()
  if (env) throw new Error('qemu-system-' + arch + ' not found, bundle it in your ' + env)

  throw new Error(
    'qemu-system-' +
      arch +
      ' not found, install it with `apt install ' +
      PACKAGES[arch] +
      '` or `dnf install qemu-kvm`'
  )
}

function firmware(arch) {
  const bios = which(FIRMWARE[arch])
  if (bios) return bios

  throw new Error('No EFI firmware found for a disk-only boot, pass opts.image.kernel')
}

function accel() {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
    return 'kvm'
  } catch (err) {
    warn(err)
    return 'tcg'
  }
}

function warn(err) {
  if (warned) return
  warned = true

  console.warn('[linux] ' + hint(err) + ', falling back to tcg which is much slower')
}

function hint(err) {
  const env = sandbox()

  if (err.code === 'EACCES') {
    return env === 'snap'
      ? '/dev/kvm is blocked, connect it with `snap connect <snap>:kvm`'
      : '/dev/kvm is not accessible, add yourself to the kvm group with `sudo usermod -aG kvm $USER` and log back in'
  }

  if (env === 'flatpak') return '/dev/kvm is missing, the flatpak manifest needs --device=kvm'
  if (env === 'snap') return '/dev/kvm is missing, connect it with `snap connect <snap>:kvm`'

  return '/dev/kvm is missing, this host has no KVM'
}

function sandbox() {
  if (process.env.SNAP) return 'snap'

  try {
    fs.accessSync('/.flatpak-info')
    return 'flatpak'
  } catch {
    return null
  }
}

async function listening(socket) {
  for (let i = 0; i < 200; i++) {
    try {
      fs.accessSync(socket)
      return
    } catch {
      await sleep(25)
    }
  }

  throw new Error('virtiofsd never bound ' + socket)
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function kill(child, signal) {
  try {
    child.kill(signal)
  } catch {} // already exited
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
