const VM = require('./')

module.exports = class WindowsVM extends VM {
  _start() {
    throw new Error('Windows host driver (Hyper-V) is not implemented yet')
  }

  _stop() {}
}
