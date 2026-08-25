# barevisor

Cross-platform sandboxed VMs for Node and Bare.

Spin up a lightweight guest, run commands in it, stream data in and out over a host-to-guest port, and tear it down — for running untrusted or platform-specific code (Python packages, network simulations, build steps) from tests and tools.

The default export boots an Alpine Linux guest, which is what `exec`, the agent and the sandbox are built around. `image` also takes a `{ disk }` of your own with `agent: false`, which boots whatever the host hypervisor can without the in-guest conveniences.

Runs on Node and Bare. Builtins resolve through package imports (`bare-fs`, `bare-net`, `bare-subprocess`, …) and Bare picks the platform driver statically via the `#driver` import map — Node falls back to runtime dispatch.

```
npm install barevisor
```

## Usage

```js
const Barevisor = require('barevisor')

const vm = new Barevisor({
  cpus: 4,
  memory: '4gb',
  packages: ['python3'],
  mounts: { '/work': process.cwd() }
})

await vm.ready()

const { stdout } = await vm.exec('python3 -c "print(1 + 1)"')

await vm.close()
```

The kernel and initramfs download once and are reused after, into the per-user directory [`bare-storage`](https://github.com/holepunchto/bare-storage) reports as persistent — `~/Library/Application Support/barevisor` on macOS, `$XDG_DATA_HOME/barevisor` on Linux, `%APPDATA%\\barevisor` on Windows.

## API

#### `const vm = new Barevisor(opts)`

A VM on the driver for the current platform. Construction is cheap and does no work — `await vm.ready()` boots the guest and waits for its agent.

Options:

```js
{
  cpus: 1,             // guest cpu count
  memory: '1gb',       // memory as '4gb', '512mb' or a number in MiB
  mounts: {},          // { '/guest/path': '/host/path' } shared via virtio-fs
  ports: [],           // extra guest ports to expose, see vm.connect
  image: null,         // an Image, or { kernel, initrd, cmdline } / { disk } paths
  debug: false         // stream the guest console and hypervisor output to stdio
}
```

With no `image` it uses `new Alpine(opts)`, so image options like `packages` can be passed straight to the constructor. `network`, `agent`, `agentPort` and `timeout` default to whatever the image declares, and can be overridden here.

#### `await vm.ready()`

Boot the guest and wait for its agent. Idempotent.

#### `const result = await vm.exec(command, [opts])`

Run a shell command in the guest through the agent. Returns `{ exitCode, signal, stdout, stderr }` — `exitCode` is `null` when the process was killed, and `signal` names the signal. Options are `{ cwd, env }`.

Commands run as root. To run untrusted code, use the sandbox below.

#### `const socket = vm.connect(port)`

Open a duplex stream to a port in the guest. The port must be listed in `opts.ports` (or be the agent port) at boot.

The transport is per-platform — vsock on macOS, virtio-serial under qemu — and either way it terminates on a unix socket the host dials. On Linux a port carries **one connection at a time**; on macOS it accepts many.

#### `const listener = await vm.listen(port, address)`

The other half of `vm.connect`: start a listener on a guest port and wire it to a [socat](http://www.dest-unreach.org/socat/) address, without having to know what the transport is on this platform.

```js
const listener = await vm.listen(1234, 'EXEC:/bin/cat')

const socket = await listener.connect()
socket.write('hello\n')

await listener.close()
```

`await listener.connect()` dials the port, retrying until the guest is listening. `await listener.close()` reaps the listener and frees the port. This is what `StreamDrive` moves bytes over.

#### `await vm.close()`

Shut the VM down. Idempotent.

#### `require('barevisor/vm')`

The base class all drivers extend. Implement `_start()`, `_stop()` and `_connect(port)` to add a backend. Override `transport`, `guestAddress(port)` and `guestReady` if the guest side of `vm.connect` is not vsock, and `mountType`/`mountOptions` if shared directories are not virtio-fs.

## Sandbox

`require('barevisor/sandbox')` runs untrusted code as an unprivileged user in a guest that has nothing in it but what you put there.

```js
const Sandbox = require('barevisor/sandbox')

const sandbox = new Sandbox({
  packages: ['python3', 'py3-pip'],
  install: Sandbox.pip(['python-pptx'])
})

await sandbox.ready()
await sandbox.in.put('/deck.py', b4a.from(script))

const result = await sandbox.run('python3 ../in/deck.py')
const deck = await sandbox.out.get('/deck.pptx')

await sandbox.close()
```

Two directories are shared with the host and nothing else: `in` is where you put the script and its inputs, mounted read-only in the guest, and `out` is the only writable path, where artifacts come back. Both are [`localdrive`](https://github.com/holepunchto/localdrive) instances.

With `disk: false` nothing is shared with the host filesystem at all — see [Streaming](#streaming).

#### `const sandbox = new Sandbox(opts)`

Takes everything `Barevisor` and `Alpine` take, plus:

```js
{
  install: [],         // shell run as root at boot, see the helpers below
  offline: false,      // drop the guest network once the install has finished
  dir: null,           // host directory backing in/ and out/
  user: 'sandbox',     // unprivileged user that runs the code
  uid: 1000,
  workspace: '/sandbox',
  disk: true,          // false streams in/out over guest ports instead of mounting
  transfers: 4,        // concurrent transfers when disk is false
  env: {},             // environment exported for every run
  cpuTime: 30,         // rlimit on cpu seconds, also the default run timeout
  maxFileSize: 67108864,
  maxProcesses: 64,
  sfw: true            // preinstall the sfw npm package
}
```

#### `const result = await sandbox.run(command, [opts])`

Run a command as the unprivileged user, from `out/` as the working directory. Applies the rlimits and a wall-clock `timeout` (defaults to `cpuTime`), then kills anything the run left behind so one run cannot degrade the next. Options are `{ timeout, env }`.

#### `Sandbox.pip(packages)` / `Sandbox.npm(packages, [opts])`

Build an install step for `opts.install`. Both validate every specifier against a conservative charset and shell-quote it, so a package name can never carry shell syntax into the guest's root shell:

```js
install: [Sandbox.pip(['python-pptx']), Sandbox.npm(['left-pad'])]
```

`npm` passes `--ignore-scripts`, so installing a package cannot execute that package's own code. It installs globally by default; pass `{ prefix: '/sandbox' }` to install into a directory instead. npm cannot do a local install at `/`, which is why there is no unprefixed local mode.

### Streaming

`disk: false` shares no host directory. The workspace is the guest's own tmpfs — the initramfs root is already RAM — and `in`/`out` become `StreamDrive` instances that move bytes over guest ports, so a file's only copy is in guest memory unless you write it somewhere yourself.

```js
const sandbox = new Sandbox({ disk: false, packages: ['python3'] })

await sandbox.ready()
await sandbox.in.put('/deck.py', script)
await sandbox.run('python3 ../in/deck.py')

sandbox.out.createReadStream('/deck.pptx').pipe(drive.createWriteStream('/deck.pptx'))
```

`StreamDrive` offers the same surface as a localdrive — `get`, `put`, `entry`, `list`, `del`, `createReadStream`, `createWriteStream` — so the two modes are interchangeable.

Reads stream at any size. Writes buffer the payload on the host before sending it, because vfkit never propagates a socket close into the guest: neither side can use EOF to end a transfer, so both directions are bounded by an explicit byte count, which reads take from the file and writes from the payload. Inputs are usually small, so buffering them is cheap; large artifacts move in the direction that streams. Agent v2 replaces this with framed channels and removes both the buffering and the transfer port pool.

Transfers need a guest port each, reserved at boot, so `transfers` caps how many can run at once.

### What the sandbox does and does not guarantee

The boundary that matters is the VM: the guest has its own kernel and reaches the host only through the devices configured for it. Inside that, code runs as uid 1000 on an ephemeral tmpfs, cannot traverse into the agent or write anywhere but `out/`, and is capped on cpu time, file size and process count.

What it does not do yet:

- **Network egress is not restricted by default.** Packages install at boot over the network, so `offline: true` drops the interface _after_ the install — it does not stop a package's install from reaching the network in the first place. A guest image with packages baked in removes that window; see the roadmap.
- **`--ignore-scripts` breaks native modules.** Anything that compiles or downloads a binary during install will not work, because that is exactly the code being suppressed. Use prebuilt wheels via a mount instead.
- **`disk: false` keeps file contents off the host, not the VM's own bookkeeping.** the hypervisor's port sockets and the kernel console log still live in a temp directory, and guest RAM can be paged out by the host, so this is not a defence against disk forensics.

## Images

An image is the thing a VM boots. It reads its files from a drive and materializes them into a local cache, so the same image works whether it comes from an HTTPS mirror, a `localdrive` of prebuilt files, or a `hyperdrive`.

#### `const image = new Alpine(opts)`

```js
const Alpine = require('barevisor/alpine')
```

Alpine Linux from the netboot mirror, with the guest agent baked into the initramfs.

```js
{
  packages: [],        // apk packages installed at boot, on top of nodejs + socat
  version: '3.22',     // alpine release
  arch: 'aarch64',     // defaults to the host architecture
  mirror: '...',       // alpine mirror url, used by apk inside the guest
  drive: null,         // where to read vmlinuz/initramfs from, defaults to the mirror over https
  cache: '...',         // defaults to the persistent per-user directory
  agent: true          // set false for a stock image with no agent
}
```

Pass `drive` to boot from files you already have, with no network at all:

```js
const Localdrive = require('localdrive')

const vm = new Barevisor({ image: new Alpine({ drive: new Localdrive('./images') }) })
```

or from your Peers

```js
const Hyperdrive = require('hyperdrive')

const vm = new Barevisor({ image: new Alpine({ drive: new Hyperdrive(store) }) })
```

#### `const image = new Image(drive, opts)`

```js
const Image = require('barevisor/image')
```

The base class, for any other image. `drive` is anything with `ready()` and `get(key)` — `localdrive`, `hyperdrive` or `require('barevisor/http-drive')`. Pass `drive` as `null` to use `kernel`/`initrd` paths you already have on disk.

```js
{
  name: 'image',       // cache directory name
  keys: { kernel: '/vmlinuz', initrd: '/initramfs' },
  cmdline: 'console=hvc0',
  agent: true,         // append the guest agent to the initramfs as a cpio overlay
  agentPort: 5555,     // guest port the agent listens on
  network: false,      // whether the guest needs a NAT network
  timeout: 30000       // how long to wait for the agent after boot
}
```

Subclass it and override `overlay()` to add your own files to the initramfs. `await image.ready()` materializes it without booting anything, which is how you prefetch in CI.

### Guest agent

`require('barevisor/agent')` is a small server the guest runs at boot. It listens on a unix socket (bridged to the host with socat) and answers newline-delimited JSON requests — `ping` and `exec`. `Image` packs it into the initramfs for you. Because it is plain JavaScript it is also runnable on the host, which is how this package's test suite exercises the full boot/exec/close contract without a hypervisor.

## Drivers

| Platform | Backend                            | Status      |
| -------- | ---------------------------------- | ----------- |
| darwin   | Virtualization.framework via vfkit | implemented |
| linux    | qemu                               | implemented |
| win32    | Hyper-V                            | planned     |

On macOS install [vfkit](https://github.com/crc-org/vfkit) with `brew install vfkit`. vfkit ships the `com.apple.security.virtualization` entitlement, which is why it is used instead of an unsigned helper binary.

### Linux

Install qemu — `apt install qemu-system-x86`, `dnf install qemu-kvm`, `pacman -S qemu-base` — and nothing else. Pass `qemu` to point at a specific binary, or set `LINUX_QEMU`.

KVM is used when `/dev/kvm` is readable and writable, otherwise the guest runs under tcg emulation, which needs no privileges at all but is much slower. Either way it boots. The choice is reported on `vm.accel` and can be forced with `accel: 'kvm' | 'tcg'`. On Debian and Ubuntu `/dev/kvm` is `0660 root:kvm`, so KVM needs `sudo usermod -aG kvm $USER` and a fresh login; Arch and Fedora ship it world-accessible.

`mounts` prefers `virtiofsd` and falls back to virtio-9p when it is not installed. RHEL builds qemu without 9p, so install `virtiofsd` there, or use the sandbox with `disk: false`, which shares nothing.

Guest ports are virtio-serial ports rather than vsock, because qemu cannot bridge vsock to a host unix socket and neither Node nor Bare can open an `AF_VSOCK` socket. That needs no kernel modules and no network, so it keeps working with the guest network down.

#### Snap and flatpak

Both sandboxes hide the host's qemu, so bundle it in the app; `$SNAP/usr/bin` and `/app/bin` are searched. A bundled qemu also needs its `pc-bios` blobs — point at them with `datadir` or `LINUX_QEMU_DATADIR`.

For KVM, a flatpak manifest needs `--device=kvm` in `finish-args` and a snap needs `snap connect <snap>:kvm`, neither of which the library can grant itself. Without them everything still runs, under tcg.

## Examples

- `node example/exec-python.js` — boot an Alpine guest with python3 and run code in it
- `node example/sandbox-pptx.js` — build a PowerPoint deck with python-pptx in a sealed guest and read it back
- `node example/sandbox-stream.js` — the same deck with nothing shared with the host filesystem
- `node example/sandbox-offline.js` — install packages at boot, then run with the network dropped
- `node example/port-echo.js` — round-trip a message over a guest port with `vm.connect()`

Both run under `bare` too.

## Roadmap

- **Guest image pipeline** — a purpose-built Alpine image (modern kernel with `sch_netem`, network namespaces, Python, Bare preinstalled, agent baked in), built in CI and seeded over Hyperdrive with the HTTPS mirror as fallback. Drops the apk install at boot, so guests no longer need network.
- **Agent v2** — replace the JSON-line protocol with Protomux + compact-encoding channels, adding streaming `spawn` with live stdio.
- **win32** — a Hyper-V driver, the last platform without one.
- **`badnet`** — a separate package composed on this one: boot a VM, carve it into network namespaces, and degrade links (latency, jitter, loss) live from tests.

## License

Apache-2.0
