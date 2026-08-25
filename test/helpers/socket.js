const os = require('os')
const path = require('path')
const process = require('process')

// windows has no unix sockets in the filesystem — node and bare both listen on
// named pipes there instead
module.exports = function socketPath(name) {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\' + name
    : path.join(os.tmpdir(), name + '.sock')
}
