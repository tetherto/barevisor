// Same deck as sandbox-pptx.js, except nothing is shared with the host
// filesystem: the script goes in and the artifact comes back over a port, so
// the only copy of either is in guest memory.
//
//   node example/sandbox-stream.js

const process = require('process')
const b4a = require('b4a')
const Sandbox = require('../sandbox')

const DECK = `
from pptx import Presentation

deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[0])
slide.shapes.title.text = "Never touched a disk"
deck.save("deck.pptx")

print("wrote deck.pptx")
`

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const sandbox = new Sandbox({
    cpus: 2,
    disk: false,
    packages: ['python3', 'py3-pip'],
    install: Sandbox.pip(['python-pptx'])
  })

  await sandbox.ready()

  await sandbox.in.put('/deck.py', b4a.from(DECK))

  const result = await sandbox.run('python3 ../in/deck.py')
  console.log('exit', result.exitCode, '|', result.stdout.trim())

  for await (const entry of sandbox.out.list()) {
    const { value } = await sandbox.out.entry(entry.key)
    console.log('out' + entry.key, value.blob.byteLength, 'bytes')
  }

  // pipe it anywhere without it ever landing on this machine
  let bytes = 0
  for await (const chunk of sandbox.out.createReadStream('/deck.pptx')) bytes += chunk.length

  console.log('streamed', bytes, 'bytes off the guest, host staging dir:', sandbox.staging)

  // to land it on disk, pipe it into a Localdrive:
  //   sandbox.out.createReadStream('/deck.pptx').pipe(drive.createWriteStream('deck.pptx'))

  await sandbox.close()
}
