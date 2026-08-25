const VM = require('./')

module.exports = class LinuxVM extends VM {
  _start() {
    throw new Error('Linux host driver (qemu/KVM) is not implemented yet')
  }

  _stop() {}
}
