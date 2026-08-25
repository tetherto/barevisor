const process = require('process')

// Node fallback for the #driver import map — Bare resolves the platform
// condition statically and never loads this file
const PLATFORMS = {
  darwin: () => require('./darwin'),
  linux: () => require('./linux'),
  win32: () => require('./win32')
}

const load = PLATFORMS[process.platform]
if (!load) throw new Error('Unsupported platform: ' + process.platform)

module.exports = load()
