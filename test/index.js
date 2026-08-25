const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const test = require('brittle')

const b4a = require('b4a')
const Linux = require('..')
const VM = require('../lib/vm')
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
const MockVM = require('./helpers/mock')
const MockDrive = require('./helpers/drive')

test('ready boots the vm', async function (t) {
  const vm = await create(t)

  t.ok(vm.opened)
})

test('linux is a platform driver with a default alpine image', function (t) {
  const vm = new Linux({ packages: ['python3'] })

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
  t.ok(Linux.prototype instanceof VM)
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

async function create(t) {
  const vm = new MockVM()
  t.teardown(() => vm.close())
  await vm.ready()
  return vm
}

function cache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-cache-'))
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
