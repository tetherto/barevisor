const Alpine = require('./alpine')
const quote = require('../shell-quote')

// package specifiers, minus anything that could carry shell syntax
const REQUIREMENT = /^[\w.\-[\],<>=!~*+]+$/
const SPECIFIER = /^@?[\w.\-/]+(@[\w.\-^~*<>=|\s]+)?$/

module.exports = class SandboxImage extends Alpine {
  constructor(opts = {}) {
    super(opts)

    this.user = opts.user || 'sandbox'
    this.uid = opts.uid || 1000
    this.workspace = opts.workspace || '/sandbox'
    this.sfw = opts.sfw ?? false
    this.install = [].concat(opts.install || [])

    if (this.sfw) this.install.push(SandboxImage.npm(['sfw']))
  }

  static pip(packages) {
    return (
      'pip install --break-system-packages --quiet --root-user-action=ignore ' +
      safe(packages, REQUIREMENT) +
      ' || fail pip'
    )
  }

  // --ignore-scripts so installing a package cannot execute its own code.
  // npm cannot do a local install at /, so a prefix is the only alternative
  // to installing globally
  static npm(packages, { prefix = null } = {}) {
    return (
      'npm install --ignore-scripts --no-audit --no-fund --silent ' +
      (prefix ? '--prefix ' + quote(prefix) + ' ' : '--global ') +
      safe(packages, SPECIFIER) +
      ' || fail npm'
    )
  }

  setup() {
    // the kernel creates the initramfs root as 0700, so an unprivileged user
    // cannot traverse it at all
    return `echo '[linux] sealing guest'
chmod 755 /
adduser -D -u ${this.uid} -h ${this.workspace} ${this.user} || fail adduser
mkdir -p ${this.workspace}/in ${this.workspace}/out
chown 0:0 ${this.workspace} ${this.workspace}/in
chmod 755 ${this.workspace} ${this.workspace}/in
chown ${this.uid} ${this.workspace}/out
chmod 700 /agent /run
${this.install.join('\n')}`
  }
}

function safe(packages, pattern) {
  for (const name of packages) {
    // a leading dash would be read as an option rather than a package
    if (name[0] === '-' || !pattern.test(name)) {
      throw new Error('Unsafe package name: ' + name)
    }
  }

  return packages.map(quote).join(' ')
}
