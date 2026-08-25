// Boots a guest, starts an echo server on a vsock port and round-trips a
// message over vm.connect().
//
//   node example/vsock-echo.js

const process = require('process')
const Linux = require('..')

const PORT = 1234

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const vm = new Linux({ ports: [PORT] })

  await vm.ready()
  await vm.exec(`socat VSOCK-LISTEN:${PORT},reuseaddr,fork EXEC:/bin/cat >/dev/null 2>&1 &`)

  const socket = vm.connect(PORT)
  socket.write('hello from the host\n')

  const reply = await new Promise((resolve) => socket.once('data', resolve))
  console.log('guest echoed:', reply.toString().trim())

  socket.destroy()
  await vm.close()
}
