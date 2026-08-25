const os = require('os')
const b4a = require('b4a')
const HttpDrive = require('../http-drive')
const Image = require('./')

const ARCHS = { arm64: 'aarch64', x64: 'x86_64' }

module.exports = class AlpineImage extends Image {
  constructor(opts = {}) {
    const version = opts.version || '3.22'
    const arch = opts.arch || ARCHS[os.arch()]
    const mirror = opts.mirror || 'https://dl-cdn.alpinelinux.org/alpine/v' + version
    const netboot = mirror + '/releases/' + arch + '/netboot'
    const agent = opts.agent ?? true

    super(opts.drive || new HttpDrive(netboot), {
      name: 'alpine-' + version + '-' + arch,
      keys: { kernel: '/vmlinuz-virt', initrd: '/initramfs-virt' },
      network: agent,
      timeout: agent ? 300000 : 30000,
      ...opts
    })

    this.version = version
    this.arch = arch
    this.mirror = mirror
    this.netboot = netboot
    this.packages = opts.packages || []
  }

  async overlay() {
    return [
      { name: 'init', data: b4a.from(this.init()), mode: 0o100755 },
      ...(await super.overlay())
    ]
  }

  setup() {
    return ''
  }

  // the guest end of vm.connect(), which is a vsock port on macOS and a
  // virtio-serial port under qemu
  listener() {
    if (this.transport === 'vport') {
      // socat exits if it opens the port before the agent is listening, and the
      // guest closing its end resets whatever the host had connected, so wait
      // for the socket to show up rather than churning
      return `while :; do
  [ -S /run/agent.sock ] && socat GOPEN:$(/agent/vport port-${this.agentPort}) UNIX-CONNECT:/run/agent.sock
  sleep 0.2
done &`
    }

    return `modprobe vmw_vsock_virtio_transport || fail vsock

socat VSOCK-LISTEN:${this.agentPort},reuseaddr,fork UNIX-CONNECT:/run/agent.sock &`
  }

  init() {
    const packages = ['nodejs', 'socat', ...this.packages].join(' ')

    return `#!/bin/sh

export PATH=/usr/bin:/usr/sbin:/bin:/sbin

/bin/busybox --install -s

fail() {
  echo "[linux] failed: $1"
  sleep 2147483647
}

mkdir -p /proc /sys /dev /run /tmp /.modloop /lib/apk/db /var/cache/apk
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

modprobe virtio_net
ip link set lo up
ip link set eth0 up
udhcpc -i eth0 -q -t 20 || fail dhcp

apk add --initdb --no-cache --repository ${this.mirror}/main --repository ${this.mirror}/community ${packages} || fail apk
${this.setup()}

modprobe virtiofs
wget -q -O /run/modloop ${this.netboot}/modloop-virt || fail modloop-download
mount -o loop -t squashfs /run/modloop /.modloop || fail modloop-mount
mount -o bind /.modloop/modules /lib/modules
node /agent/run.js /run/agent.sock &
${this.listener()}

# pid 1 stays in wait() so orphaned processes get reaped instead of piling up
# as zombies against the sandbox user's process limit
wait
`
  }
}
