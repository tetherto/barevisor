// Generates a PowerPoint deck with python-pptx inside a sealed guest and
// reads the file back out on the host. The script runs as an unprivileged
// user with no access to the host beyond the two mounted directories.
//
//   node example/sandbox-pptx.js

const fs = require('fs')
const path = require('path')
const process = require('process')
const b4a = require('b4a')
const Sandbox = require('../sandbox')

const DECK = `
from pptx import Presentation
from pptx.util import Pt

deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[0])
slide.shapes.title.text = "Built in a sandbox"
slide.placeholders[1].text = "python-pptx, running sealed inside a VM"
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
    packages: ['python3', 'py3-pip'],
    install: Sandbox.pip(['python-pptx'])
  })

  console.log('booting')
  await sandbox.ready()
  console.log('ready')

  await sandbox.in.put('/deck.py', b4a.from(DECK))

  const result = await sandbox.run('python3 ../in/deck.py')
  console.log('exit', result.exitCode, '|', result.stdout.trim())

  const deck = await sandbox.out.get('/deck.pptx')
  const dest = path.join(__dirname, 'deck.pptx')
  fs.writeFileSync(dest, deck)

  console.log('wrote', dest, '(' + deck.length + ' bytes)')

  await sandbox.close()
}
