const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const process = require('process')
const zlib = require('zlib')
const test = require('brittle')

const b4a = require('b4a')
const storage = require('bare-storage')
const Barevisor = require('..')
const VM = require('../lib/vm')
const LinuxVM = require('../lib/vm/linux')
const which = require('../lib/vm/which')
const Image = require('../lib/image')
const Alpine = require('../lib/image/alpine')
const cpio = require('../lib/cpio')
const zboot = require('../lib/zboot')
const quote = require('../lib/shell-quote')
const SandboxImage = require('../lib/image/sandbox')
const PortPool = require('../lib/port-pool')
const StreamDrive = require('../lib/stream-drive')
const Sandbox = require('../sandbox')
const MockGuest = require('./helpers/guest')
const socketPath = require('./helpers/socket')
const MockVM = require('./helpers/mock')
const MockDrive = require('./helpers/drive')

test('ready boots the vm', async function (t) {
  const vm = await create(t)

  t.ok(vm.opened)
})

test('barevisor is a platform driver with a default alpine image', function (t) {
  const vm = new Barevisor({ packages: ['python3'] })

  t.ok(vm instanceof VM)
  t.ok(vm.image instanceof Alpine)
  t.alike(vm.image.packages, ['python3'])
})

test('exec runs a command and captures stdio', async function (t) {
  const vm = await create(t)

  const result = await vm.exec('echo hello && echo oops 1>&2')

  t.is(result.exitCode, 0)
  t.is(result.stdout, 'hello\n')
  t.is(result.stderr, 'oops\n')
})

test('exec reports exit codes', async function (t) {
  const vm = await create(t)

  const result = await vm.exec('exit 3')

  t.is(result.exitCode, 3)
})

test('exec supports cwd and env', async function (t) {
  const vm = await create(t)

  const result = await vm.exec('echo $FOO && pwd', { cwd: '/', env: { FOO: 'bar' } })

  t.is(result.stdout, 'bar\n/\n')
})

test('concurrent execs share one agent connection', async function (t) {
  const vm = await create(t)

  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => vm.exec('echo ' + i)))

  t.alike(
    results.map((r) => r.stdout),
    ['0\n', '1\n', '2\n', '3\n', '4\n']
  )
})

test('connect returns a duplex stream to a vsock port', async function (t) {
  const vm = await create(t)

  const socket = vm.connect(vm.agentPort)
  t.teardown(() => socket.destroy())

  socket.write(JSON.stringify({ id: 1, method: 'ping' }) + '\n')

  const reply = await new Promise((resolve) => socket.once('data', resolve))
  t.alike(JSON.parse(reply.toString()), { id: 1, result: 'pong' })
})

test('exec rejects once the agent connection is gone', async function (t) {
  const vm = await create(t)

  await vm.exec('true')

  const socket = vm._client.socket
  socket.destroy()
  await new Promise((resolve) => socket.once('close', resolve))

  await t.exception(vm.exec('true'), /Agent socket closed/)
})

test('memory accepts numbers and unit strings', function (t) {
  t.is(new MockVM({ memory: '4gb' }).memory, 4096)
  t.is(new MockVM({ memory: '512mb' }).memory, 512)
  t.is(new MockVM({ memory: 2048 }).memory, 2048)
})

test('close is idempotent', async function (t) {
  const vm = await create(t)

  await vm.close()
  await vm.close()

  t.ok(vm.closed)
})

test('vm is the base class of every driver', function (t) {
  t.ok(MockVM.prototype instanceof VM)
  t.ok(Barevisor.prototype instanceof VM)
})

test('vm takes its agent and network defaults from the image', function (t) {
  const image = new Image(null, { agentPort: 9000, network: true, timeout: 1000 })
  const vm = new MockVM({ image })

  t.is(vm.agentPort, 9000)
  t.is(vm.network, true)
  t.is(vm.timeout, 1000)
})

test('vm options override the image defaults', function (t) {
  const image = new Image(null, { agentPort: 9000, network: true })
  const vm = new MockVM({ image, agentPort: 22, network: false })

  t.is(vm.agentPort, 22)
  t.is(vm.network, false)
})

test('vm opens the image before starting', async function (t) {
  const order = []

  class Recording extends MockVM {
    _start() {
      order.push('start')
      return super._start()
    }
  }

  const image = new Image()
  image._open = () => order.push('image')

  const vm = new Recording({ image })
  t.teardown(() => vm.close())
  await vm.ready()

  t.alike(order, ['image', 'start'])
})

test('image materializes kernel and initrd from a drive', async function (t) {
  const drive = new MockDrive({ '/vmlinuz': 'kernel-bytes', '/initramfs': 'initrd-bytes' })
  const image = new Image(drive, { agent: false, ...cache(t) })

  await image.ready()

  t.alike(drive.reads, ['/vmlinuz', '/initramfs'])
  t.is(fs.readFileSync(image.kernel, 'utf8'), 'kernel-bytes')
  t.is(fs.readFileSync(image.initrd, 'utf8'), 'initrd-bytes')
})

test('image appends the agent overlay to the initrd', async function (t) {
  const drive = new MockDrive({ '/vmlinuz': 'kernel-bytes', '/initramfs': 'initrd-bytes' })
  const image = new Image(drive, cache(t))

  await image.ready()

  const initrd = fs.readFileSync(image.initrd)
  const base = b4a.from('initrd-bytes')

  t.alike(initrd.subarray(0, base.length), base)
  t.ok(initrd.length > base.length)

  const overlay = b4a.toString(zlib.gunzipSync(initrd.subarray(base.length)))
  t.ok(overlay.includes('agent/run.js'))
})

test('image reuses what the drive already gave it', async function (t) {
  const opts = cache(t)
  const entries = { '/vmlinuz': 'kernel-bytes', '/initramfs': 'initrd-bytes' }

  await new Image(new MockDrive(entries), opts).ready()

  const drive = new MockDrive(entries)
  await new Image(drive, opts).ready()

  t.alike(drive.reads, [])
})

test('image ready is idempotent under concurrent callers', async function (t) {
  const drive = new MockDrive({ '/vmlinuz': 'kernel-bytes', '/initramfs': 'initrd-bytes' })
  const image = new Image(drive, cache(t))

  await Promise.all([image.ready(), image.ready(), image.ready()])

  t.alike(drive.reads, ['/vmlinuz', '/initramfs'])
})

test('concurrent images sharing a cache do not corrupt it', async function (t) {
  const opts = cache(t)
  const kernel = b4a.alloc(256 * 1024, 7)
  const entries = { '/vmlinuz': kernel, '/initramfs': 'initrd-bytes' }

  const images = [
    new Image(new MockDrive(entries), { agent: false, ...opts }),
    new Image(new MockDrive(entries), { agent: false, ...opts }),
    new Image(new MockDrive(entries), { agent: false, ...opts })
  ]

  await Promise.all(images.map((image) => image.ready()))

  t.alike(fs.readFileSync(images[0].kernel), kernel)
  t.alike(
    fs.readdirSync(images[0].dir).sort(),
    ['initramfs', 'vmlinuz'],
    'no temporary files left behind'
  )
})

test('image caches images where they survive a restart', function (t) {
  const cache = new Image(null, {}).cache

  t.is(cache, path.join(storage.persistent(), 'barevisor'))
  t.is(new Image(null, { cache: '/tmp/images' }).cache, '/tmp/images')
})

test('image without a drive uses the paths it was given', async function (t) {
  const image = Image.from({ kernel: './bzImage', initrd: './initrd.gz', cmdline: 'quiet' })

  await image.ready()

  t.is(image.kernel, './bzImage')
  t.is(image.cmdline, 'quiet')
})

test('alpine resolves a mirror, keys and packages', function (t) {
  const image = new Alpine({ version: '3.21', arch: 'x86_64', packages: ['python3'] })

  t.is(image.name, 'alpine-3.21-x86_64')
  t.is(image.drive.base, 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot')
  t.alike(image.keys, { kernel: '/vmlinuz-virt', initrd: '/initramfs-virt' })
  t.ok(image.init().includes('nodejs socat python3'))
  t.ok(image.network)
})

test('alpine takes any drive as its mirror', async function (t) {
  const drive = new MockDrive({ '/vmlinuz-virt': 'kernel', '/initramfs-virt': 'initrd' })
  const image = new Alpine({ drive, ...cache(t) })

  await image.ready()

  t.alike(drive.reads, ['/vmlinuz-virt', '/initramfs-virt'])
})

test('zboot reports the range of an efi zboot kernel', async function (t) {
  const payload = zlib.gzipSync(b4a.from('raw-kernel-image'))
  const wrapped = b4a.alloc(64 + payload.length)

  b4a.write(wrapped, 'MZ')
  b4a.write(wrapped, 'zimg', 4)

  const header = new DataView(wrapped.buffer, wrapped.byteOffset)
  header.setUint32(8, 64, true)
  header.setUint32(12, payload.length, true)
  b4a.copy(payload, wrapped, 64)

  const file = path.join(cache(t).cache, 'vmlinuz')
  fs.writeFileSync(file, wrapped)

  t.alike(await zboot(file), { offset: 64, size: payload.length })
})

test('zboot reports null for a raw kernel', async function (t) {
  const file = path.join(cache(t).cache, 'vmlinuz')
  fs.writeFileSync(file, b4a.from('already-raw-kernel-image'))

  t.is(await zboot(file), null)
})

test('image unwraps a zboot kernel while streaming it', async function (t) {
  const payload = zlib.gzipSync(b4a.from('raw-kernel-image'))
  const wrapped = b4a.alloc(64 + payload.length)

  b4a.write(wrapped, 'zimg', 4)

  const header = new DataView(wrapped.buffer, wrapped.byteOffset)
  header.setUint32(8, 64, true)
  header.setUint32(12, payload.length, true)
  b4a.copy(payload, wrapped, 64)

  const drive = new MockDrive({ '/vmlinuz': wrapped, '/initramfs': 'initrd-bytes' })
  const image = new Image(drive, { agent: false, ...cache(t) })

  await image.ready()

  t.is(fs.readFileSync(image.kernel, 'utf8'), 'raw-kernel-image')
  t.absent(fs.existsSync(image.kernel + '.zboot'))
})

test('mounts normalize to a path and a readonly flag', function (t) {
  const vm = new MockVM({ mounts: { '/a': '/host/a', '/b': { path: '/host/b', readonly: true } } })

  t.alike(vm.mounts, {
    '/a': { path: '/host/a', readonly: false },
    '/b': { path: '/host/b', readonly: true }
  })
})

test('shell quote neutralizes embedded quotes', function (t) {
  t.is(quote('echo hi'), "'echo hi'")
  t.is(quote("it's"), "'it'\\''s'")
})

test('pip and npm helpers quote every package', function (t) {
  t.ok(SandboxImage.pip(['requests==2.*']).includes("'requests==2.*'"))
  t.ok(SandboxImage.npm(['left-pad']).includes('--global'))
  t.ok(SandboxImage.npm(['left-pad'], { prefix: '/sandbox' }).includes("--prefix '/sandbox'"))
  t.ok(SandboxImage.npm(['left-pad']).includes('--ignore-scripts'))
})

test('pip and npm helpers reject shell metacharacters', function (t) {
  for (const bad of ['a; id', 'a$(id)', "a'b", 'a b', 'a`id`', '-rf', '--no-deps']) {
    t.exception(() => SandboxImage.pip([bad]), /Unsafe package name/)
    t.exception(() => SandboxImage.npm([bad]), /Unsafe package name/)
  }
})

test('sandbox image collects install steps in order', function (t) {
  const image = new SandboxImage({ sfw: true, install: [SandboxImage.pip(['requests'])] })
  const setup = image.setup()

  t.ok(setup.indexOf('adduser') < setup.indexOf('pip install'))
  t.ok(setup.indexOf('pip install') < setup.indexOf('npm install'))
  t.ok(setup.includes("--global 'sfw'"))
})

test('port pool hands out ports and queues once empty', async function (t) {
  const pool = new PortPool([1, 2])

  const first = await pool.acquire()
  const second = await pool.acquire()

  t.alike([first, second].sort(), [1, 2])

  let third = null
  pool.acquire().then((port) => {
    third = port
  })

  t.is(third, null, 'waits while the pool is empty')

  pool.release(first)
  await Promise.resolve()

  t.is(third, first, 'the waiter gets the released port')
})

test('stream drive resolves keys against its guest root', function (t) {
  const drive = new StreamDrive(new MockGuest(), '/sandbox/out')

  t.is(drive._path('/deck.pptx'), '/sandbox/out/deck.pptx')
  t.is(drive._path('deck.pptx'), '/sandbox/out/deck.pptx')
})

test('stream drive reports entries from the guest', async function (t) {
  const guest = new MockGuest({ '/sandbox/out/deck.pptx': 'PK-and-more' })
  const drive = new StreamDrive(guest, '/sandbox/out')

  const entry = await drive.entry('/deck.pptx')

  t.is(entry.value.blob.byteLength, 11)
  t.is(await drive.entry('/missing.txt'), null)
})

test('stream drive lists what the guest holds', async function (t) {
  const guest = new MockGuest({ '/sandbox/out/a.txt': 'a', '/sandbox/out/b.txt': 'bb' })
  const drive = new StreamDrive(guest, '/sandbox/out')

  const keys = []
  for await (const entry of drive.list()) keys.push(entry.key)

  t.alike(keys.sort(), ['/a.txt', '/b.txt'])
})

test('stream drive reads nothing for a missing key', async function (t) {
  const drive = new StreamDrive(new MockGuest(), '/sandbox/out', { pool: new PortPool([1]) })

  await t.exception(drive.get('/missing.txt'), /Not found/)
})

test('stream drive writes over a listener on a pooled port', async function (t) {
  const guest = new MockGuest()
  const drive = new StreamDrive(guest, '/sandbox/out', { pool: new PortPool([5556]) })

  await drive.put('/x.txt', b4a.from('hello'))

  const socat = guest.commands.find((command) => command.includes('socat'))

  t.ok(socat.includes('VSOCK-LISTEN:5556,reuseaddr'))
  t.ok(socat.includes('head -c 5'))
  t.ok(socat.includes('/sandbox/out/x.txt'))
  t.ok(socat.includes("grep -q 'listening on'"))
  t.ok(guest.commands.some((command) => command.includes('kill -9 123')))
})

test('stream drive skips the bind wait when the backend queues writes', async function (t) {
  const guest = new MockGuest()

  guest.guestReady = null
  guest.guestAddress = (port) => 'GOPEN:$(/agent/vport port-' + port + ')'

  const drive = new StreamDrive(guest, '/sandbox/out', { pool: new PortPool([5556]) })

  await drive.put('/x.txt', b4a.from('hello'))

  const socat = guest.commands.find((command) => command.includes('socat'))

  t.ok(socat.includes('GOPEN:$(/agent/vport port-5556)'))
  t.absent(socat.includes('listening on'))
})

test('sandbox in stream mode shares no host directory', function (t) {
  const streaming = new Sandbox({ disk: false })

  t.is(streaming.staging, null)
  t.alike(streaming.mounts, {})
  t.is(streaming.ports.length, 4, 'reserves transfer ports')
  t.ok(streaming.in instanceof StreamDrive)
  t.ok(streaming.out instanceof StreamDrive)
})

test('sandbox on disk mounts a staging directory', function (t) {
  const disk = new Sandbox({})

  t.ok(disk.staging)
  t.is(Object.keys(disk.mounts).length, 2)
  t.is(disk.mounts['/sandbox/in'].readonly, true)
  t.is(disk.mounts['/sandbox/out'].readonly, undefined)
})

test('cpio encodes a valid newc archive', function (t) {
  const archive = cpio([
    { name: 'dir' },
    { name: '/dir/hello.txt', data: b4a.from('hi'), mode: 0o100644 },
    { name: 'dir/init', data: b4a.from('#!/bin/sh\n'), mode: 0o100755 }
  ])

  const entries = parseCpio(archive)

  t.alike(
    entries.map((e) => e.name),
    ['dir', 'dir/hello.txt', 'dir/init', 'TRAILER!!!']
  )
  t.is(entries[0].mode, 0o40755)
  t.is(b4a.toString(entries[1].data), 'hi')
  t.is(entries[2].mode, 0o100755)
  t.is(archive.length % 4, 0)
})

test('the guest listener follows the driver transport', function (t) {
  const vsock = new MockVM()

  t.is(vsock.transport, 'vsock')
  t.is(vsock.guestAddress(5555), 'VSOCK-LISTEN:5555,reuseaddr')
  t.is(vsock.guestReady, 'listening on')

  const vport = linux(t)

  t.is(vport.transport, 'vport')
  t.is(vport.guestAddress(5555), 'GOPEN:$(/agent/vport port-5555)')
  t.is(vport.guestReady, null)
})

test('the image is told which transport the driver speaks', function (t) {
  t.is(new MockVM().image.transport, 'vsock')
  t.is(linux(t).image.transport, 'vport')
})

test('alpine listens on the transport the driver speaks', function (t) {
  const image = new Alpine({})

  t.ok(image.init().includes('socat VSOCK-LISTEN:5555,reuseaddr,fork'))

  image.transport = 'vport'

  t.ok(image.init().includes('socat GOPEN:$(/agent/vport port-5555)'))
  t.absent(image.init().includes('vmw_vsock_virtio_transport'))
})

test('the vport resolver is only packed for the vport transport', async function (t) {
  const vsock = await new Image(null, {}).overlay()
  t.absent(vsock.some((entry) => entry.name === 'agent/vport'))

  const vport = await new Image(null, { transport: 'vport' }).overlay()
  const entry = vport.find((entry) => entry.name === 'agent/vport')

  t.is(entry.mode, 0o100755)
  t.ok(b4a.toString(entry.data).includes('/sys/class/virtio-ports'))
})

test('mounts use the fs type and options the driver asks for', async function (t) {
  const commands = []
  const vm = new MockVM({ mounts: { '/work': '/tmp', '/ro': { path: '/tmp', readonly: true } } })

  vm._rpc = () => ({ exec: (command) => commands.push(command) })
  vm.mountType = '9p'
  vm.mountOptions = 'trans=virtio'

  await vm._mountAll()

  t.alike(commands, [
    'mkdir -p "/work" && mount -t 9p -o trans=virtio work "/work"',
    'mkdir -p "/ro" && mount -t 9p -o trans=virtio,ro ro "/ro"'
  ])
})

test('the agent wait retries on one connection and gives up when it is never answered', async function (t) {
  const socket = socketPath('barevisor-silent-' + process.pid)
  const accepted = []

  const server = net.createServer((connection) => accepted.push(connection))
  await new Promise((resolve) => server.listen(socket, resolve))

  t.teardown(async function () {
    for (const connection of accepted) connection.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const vm = new (class extends VM {
    _connect() {
      return net.connect(socket)
    }
    _start() {}
    _stop() {}
    // long enough for more than one ping attempt, so a reconnect would show up
  })({ timeout: 3000 })

  await t.exception(vm.ready(), /Timed out waiting for guest agent/)
  t.is(accepted.length, 1)
})

test('linux boots the image kernel directly', function (t) {
  const args = linux(t, { image: { kernel: '/vmlinuz', initrd: '/initramfs' } })._args()

  t.is(args[args.indexOf('-kernel') + 1], '/vmlinuz')
  t.is(args[args.indexOf('-initrd') + 1], '/initramfs')
  t.is(args[args.indexOf('-append') + 1], 'console=hvc0')
})

test('linux pairs -cpu with the accelerator', function (t) {
  const kvm = linux(t, { accel: 'kvm' })._args()
  const tcg = linux(t, { accel: 'tcg' })._args()

  t.is(kvm[kvm.indexOf('-accel') + 1], 'kvm')
  t.is(kvm[kvm.indexOf('-cpu') + 1], 'host')
  t.is(tcg[tcg.indexOf('-accel') + 1], 'tcg')
  t.is(tcg[tcg.indexOf('-cpu') + 1], 'max')
})

test('linux keeps the console on port 0 and numbers the rest', function (t) {
  const devices = values(linux(t, { ports: [1234, 5678] })._args(), '-device')

  t.ok(devices.includes('virtconsole,bus=vs0.0,chardev=con0,nr=0'))
  t.ok(devices.includes('virtserialport,bus=vs0.0,chardev=p5555,nr=1,name=port-5555'))
  t.ok(devices.includes('virtserialport,bus=vs0.0,chardev=p1234,nr=2,name=port-1234'))
  t.ok(devices.includes('virtserialport,bus=vs0.0,chardev=p5678,nr=3,name=port-5678'))
})

test('linux serves every port on its own unix socket', function (t) {
  const vm = linux(t, { ports: [1234] })
  const chardevs = values(vm._args(), '-chardev')

  for (const port of [5555, 1234]) {
    t.ok(
      chardevs.includes(
        'socket,id=p' + port + ',path=' + vm._socketPath(port) + ',server=on,wait=off'
      )
    )
  }
})

test('linux shares directories over 9p without a helper daemon', function (t) {
  const vm = linux(t, { mounts: { '/work': '/tmp', '/ro': { path: '/tmp', readonly: true } } })

  vm.mountType = '9p'

  t.alike(values(vm._args(), '-fsdev'), [
    'local,id=fswork,path=/tmp,security_model=none,multidevs=remap',
    'local,id=fsro,path=/tmp,security_model=none,multidevs=remap,readonly=on'
  ])
  t.ok(values(vm._args(), '-device').includes('virtio-9p-pci,fsdev=fswork,mount_tag=work'))
  t.absent(vm._args().includes('-object'))
})

test('linux shares directories over virtiofs on shared memory', function (t) {
  const vm = linux(t, { mounts: { '/work': '/tmp' }, memory: '2gb' })
  const args = vm._args()

  t.is(args[args.indexOf('-machine') + 1], 'q35,memory-backend=mem')
  t.is(args[args.indexOf('-object') + 1], 'memory-backend-memfd,id=mem,size=2048M,share=on')
  t.ok(values(args, '-device').includes('vhost-user-fs-pci,chardev=fswork,tag=work'))
})

test('linux only adds a network device when the image wants one', function (t) {
  t.absent(linux(t, { network: false })._args().includes('-netdev'))
  t.is(linux(t, { network: true })._args().indexOf('-netdev') > -1, true)
})

test('which resolves absolute candidates and gives up on unknown names', function (t) {
  t.is(which(['barevisor-not-a-real-binary', process.execPath]), process.execPath)
  t.is(which(['barevisor-not-a-real-binary']), null)
})

async function create(t) {
  const vm = new MockVM()
  t.teardown(() => vm.close())
  await vm.ready()
  return vm
}

function linux(t, opts = {}) {
  const vm = new LinuxVM({
    image: { kernel: '/vmlinuz' },
    qemu: '/usr/bin/qemu-system-x86_64',
    accel: 'kvm',
    arch: 'x86_64',
    ...opts
  })

  t.teardown(() => fs.rmSync(vm.dir, { recursive: true, force: true }))

  return vm
}

function values(args, flag) {
  return args.filter((value, i) => args[i - 1] === flag)
}

function cache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barevisor-cache-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { cache: dir }
}

function parseCpio(buf) {
  const entries = []
  let offset = 0

  while (offset < buf.length) {
    const field = (i) =>
      parseInt(b4a.toString(buf, 'ascii', offset + 6 + i * 8, offset + 14 + i * 8), 16)

    if (b4a.toString(buf, 'ascii', offset, offset + 6) !== '070701') throw new Error('Bad magic')

    const mode = field(1)
    const size = field(6)
    const namesize = field(11)

    const name = b4a.toString(buf, 'ascii', offset + 110, offset + 110 + namesize - 1)
    offset += align(110 + namesize)

    const data = buf.subarray(offset, offset + size)
    offset += align(size)

    entries.push({ name, mode, data })
    if (name === 'TRAILER!!!') break
  }

  return entries
}

function align(n) {
  return n + ((4 - (n % 4)) % 4)
}
