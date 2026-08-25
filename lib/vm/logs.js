const fs = require('fs')
const path = require('path')

// stdio for a hypervisor child, kept out of the caller's terminal
module.exports = function logs(dir) {
  return [
    'ignore',
    fs.openSync(path.join(dir, 'stdout.log'), 'a'),
    fs.openSync(path.join(dir, 'stderr.log'), 'a')
  ]
}
