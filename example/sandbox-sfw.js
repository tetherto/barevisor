// Boots a sandbox with the sfw npm package preinstalled and the guest
// console streaming to stdout.
//
//   node example/sandbox-sfw.js

const process = require('process')
const Sandbox = require('../sandbox')

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const sandbox = new Sandbox({
    cpus: 2,
    sfw: true,
    debug: true
  })

  console.log('booting')
  await sandbox.ready()
  console.log('ready')

  const result = await sandbox.run('sfw npm install lodash')
  console.log('exit', result.exitCode, '|', result.stdout.trim(), result.stderr.trim())

  await sandbox.close()
}
