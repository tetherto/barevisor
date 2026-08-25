const fs = require('fs')
const path = require('path')
const process = require('process')

// resolves the first runnable candidate, searching PATH for bare names and
// including the paths a snap or flatpak keeps its own binaries under
module.exports = function which(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (executable(candidate)) return candidate
      continue
    }

    for (const dir of dirs()) {
      const file = path.join(dir, candidate)
      if (executable(file)) return file
    }
  }

  return null
}

function dirs() {
  const search = (process.env.PATH || '').split(path.delimiter).filter(Boolean)

  if (process.env.SNAP) search.push(path.join(process.env.SNAP, 'usr', 'bin'))
  search.push('/app/bin')

  return search
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
