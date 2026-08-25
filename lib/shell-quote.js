module.exports = function quote(argument) {
  return "'" + argument.replace(/'/g, `'\\''`) + "'"
}
