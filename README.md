# linux

Boot sandboxed Linux VMs from JavaScript.

Spin up a lightweight Linux guest, run commands in it, stream data in and out over vsock, and tear it down — for running untrusted or platform-specific code (Python packages, network simulations, build steps) from tests and tools.

Runs on Node and Bare. Builtins resolve through package imports (`bare-fs`, `bare-net`, `bare-subprocess`, …) and Bare picks the platform driver statically via the `#driver` import map — Node falls back to runtime dispatch.

```
npm install linux
```

## Usage

```js
const Linux = require('linux')

const vm = new Linux({
  cpus: 4,
  memory: '4gb',
  packages: ['python3'],
  mounts: { '/work': process.cwd() }
})

await vm.ready()

const { stdout } = await vm.exec('python3 -c "print(1 + 1)"')

await vm.close()
```

The kernel and initramfs download to `~/.cache/linux` on first boot and are reused after.

## API

#### `const vm = new Linux(opts)`

A VM on the driver for the current platform. Construction is cheap and does no work — `await vm.ready()` boots the guest and waits for its agent.

Options:

```js
{
  cpus: 1,             // guest cpu count
  memory: '1gb',       // memory as '4gb', '512mb' or a number in MiB
  mounts: {},          // { '/guest/path': '/host/path' } shared via virtio-fs
  ports: [],           // extra vsock ports to expose, see vm.connect
  image: null,         // an Image, or { kernel, initrd, cmdline } / { disk } paths
  debug: false         // stream the guest console and vfkit output to stdio
}
```

With no `image` it uses `new Alpine(opts)`, so image options like `packages` can be passed straight to the constructor. `network`, `agent`, `agentPort` and `timeout` default to whatever the image declares, and can be overridden here.

#### `await vm.ready()`

Boot the guest and wait for its agent. Idempotent.

#### `const result = await vm.exec(command, [opts])`

Run a shell command in the guest through the agent. Returns `{ exitCode, signal, stdout, stderr }` — `exitCode` is `null` when the process was killed, and `signal` names the signal. Options are `{ cwd, env }`.

Commands run as root. To run untrusted code, use the sandbox below.

#### `const socket = vm.connect(port)`

Open a duplex stream to a vsock port in the guest. The port must be listed in `opts.ports` (or be the agent port) at boot.

#### `await vm.close()`

Shut the VM down. Idempotent.

#### `require('linux/vm')`

The base class all drivers extend. Implement `_start()`, `_stop()` and `_connect(port)` to add a backend.

## Sandbox

`require('linux/sandbox')` runs untrusted code as an unprivileged user in a guest that has nothing in it but what you put there.

```js
const Sandbox = require('linux/sandbox')

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

#### `const sandbox = new Sandbox(opts)`

Takes everything `Linux` and `Alpine` take, plus:

```js
{
  install: [],         // shell run as root at boot, see the helpers below
  offline: false,      // drop the guest network once the install has finished
  dir: null,           // host directory backing in/ and out/
  user: 'sandbox',     // unprivileged user that runs the code
  uid: 1000,
  workspace: '/sandbox',
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

### What the sandbox does and does not guarantee

The boundary that matters is the VM: the guest has its own kernel and reaches the host only through the devices configured for it. Inside that, code runs as uid 1000 on an ephemeral tmpfs, cannot traverse into the agent or write anywhere but `out/`, and is capped on cpu time, file size and process count.

What it does not do yet:

- **Network egress is not restricted by default.** Packages install at boot over the network, so `offline: true` drops the interface _after_ the install — it does not stop a package's install from reaching the network in the first place. A guest image with packages baked in removes that window; see the roadmap.
- **`--ignore-scripts` breaks native modules.** Anything that compiles or downloads a binary during install will not work, because that is exactly the code being suppressed. Use prebuilt wheels via a mount instead.

## Images

An image is the thing a VM boots. It reads its files from a drive and materializes them into a local cache, so the same image works whether it comes from an HTTPS mirror, a `localdrive` of prebuilt files, or a `hyperdrive`.

#### `const image = new Alpine(opts)`

```js
const Alpine = require('linux/alpine')
```

Alpine Linux from the netboot mirror, with the guest agent baked into the initramfs.

```js
{
  packages: [],        // apk packages installed at boot, on top of nodejs + socat
  version: '3.22',     // alpine release
  arch: 'aarch64',     // defaults to the host architecture
  mirror: '...',       // alpine mirror url, used by apk inside the guest
  drive: null,         // where to read vmlinuz/initramfs from, defaults to the mirror over https
  cache: '~/.cache/linux',
  agent: true          // set false for a stock image with no agent
}
```

Pass `drive` to boot from files you already have, with no network at all:

```js
const Localdrive = require('localdrive')

const vm = new Linux({ image: new Alpine({ drive: new Localdrive('./images') }) })
```

or from your Peers

```js
const Hyperdrive = require('hyperdrive')

const vm = new Linux({ image: new Alpine({ drive: new Hyperdrive(store) }) })
```

#### `const image = new Image(drive, opts)`

```js
const Image = require('linux/image')
```

The base class, for any other distro. `drive` is anything with `ready()` and `get(key)` — `localdrive`, `hyperdrive` or `require('linux/http-drive')`. Pass `drive` as `null` to use `kernel`/`initrd` paths you already have on disk.

```js
{
  name: 'image',       // cache directory name
  keys: { kernel: '/vmlinuz', initrd: '/initramfs' },
  cmdline: 'console=hvc0',
  agent: true,         // append the guest agent to the initramfs as a cpio overlay
  agentPort: 5555,     // vsock port the guest agent listens on
  network: false,      // whether the guest needs a NAT network
  timeout: 30000       // how long to wait for the agent after boot
}
```

Subclass it and override `overlay()` to add your own files to the initramfs. `await image.ready()` materializes it without booting anything, which is how you prefetch in CI.

### Guest agent

`require('linux/agent')` is a small server the guest runs at boot. It listens on a unix socket (bridged to vsock with socat) and answers newline-delimited JSON requests — `ping` and `exec`. `Image` packs it into the initramfs for you. Because it is plain JavaScript it is also runnable on the host, which is how this package's test suite exercises the full boot/exec/close contract without a hypervisor.

## Drivers

| Platform | Backend                            | Status      |
| -------- | ---------------------------------- | ----------- |
| darwin   | Virtualization.framework via vfkit | implemented |
| linux    | qemu/KVM                           | planned     |
| win32    | Hyper-V                            | planned     |

On macOS install [vfkit](https://github.com/crc-org/vfkit) with `brew install vfkit`. vfkit ships the `com.apple.security.virtualization` entitlement, which is why it is used instead of an unsigned helper binary.

## Examples

- `node example/exec-python.js` — boot an Alpine guest with python3 and run code in it
- `node example/sandbox-pptx.js` — build a PowerPoint deck with python-pptx in a sealed guest and read it back
- `node example/sandbox-offline.js` — install packages at boot, then run with the network dropped
- `node example/vsock-echo.js` — round-trip a message over a vsock port with `vm.connect()`

Both run under `bare` too.

## Roadmap

- **Guest image pipeline** — a purpose-built Alpine image (modern kernel with `sch_netem`, network namespaces, Python, Bare preinstalled, agent baked in), built in CI and seeded over Hyperdrive with the HTTPS mirror as fallback. Drops the apk install at boot, so guests no longer need network.
- **Agent v2** — replace the JSON-line protocol with Protomux + compact-encoding channels, adding streaming `spawn` with live stdio.
- **`badnet`** — a separate package composed on this one: boot a VM, carve it into network namespaces, and degrade links (latency, jitter, loss) live from tests.

## License

ISC
