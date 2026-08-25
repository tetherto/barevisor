// Boots a sandboxed Alpine guest with python3 and runs code in it. The kernel
// and initramfs download to ~/.cache/linux on first run and are reused after.
//
//   node example/exec-python.js

const path = require('path')
const process = require('process')
const Barevisor = require('..')

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const vm = new Barevisor({
    cpus: 2,
    memory: '1gb',
    packages: ['python3'],
    mounts: { '/work': path.join(__dirname, '..') }
  })

  await vm.ready()

  const version = await vm.exec('python3 --version')
  console.log(version.stdout.trim())

  const sum = await vm.exec('python3 -c "print(sum(range(100)))"')
  console.log('sum(range(100)) =', sum.stdout.trim())

  const work = await vm.exec('ls /work')
  console.log('/work =', work.stdout.trim().split('\n').join(', '))

  await vm.close()
}
