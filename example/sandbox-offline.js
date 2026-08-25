// Installs packages at boot, then drops the guest network before running any
// user code. The script gets the packages it needs and no way to reach the
// network — anything it produces has to come back through /sandbox/out.
//
//   node example/sandbox-offline.js

const process = require('process')
const b4a = require('b4a')
const Sandbox = require('../sandbox')

const SCRIPT = `
import socket, json

# the package installed at boot is still here
import requests
print("requests", requests.__version__)

try:
    socket.create_connection(("1.1.1.1", 80), timeout=5)
    print("network: REACHABLE")
except OSError as err:
    print("network: sealed (" + type(err).__name__ + ")")

json.dump({"ok": True}, open("result.json", "w"))
`

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const sandbox = new Sandbox({
    cpus: 2,
    packages: ['python3', 'py3-pip'],
    install: Sandbox.pip(['requests']),
    offline: true
  })

  console.log('booting')
  await sandbox.ready()
  console.log('ready')

  await sandbox.in.put('/probe.py', b4a.from(SCRIPT))

  const result = await sandbox.run('python3 ../in/probe.py')
  console.log(result.stdout.trim())

  console.log('result.json =', b4a.toString(await sandbox.out.get('/result.json')))

  await sandbox.close()
}
