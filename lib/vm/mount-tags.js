module.exports = function mountTags(mounts) {
  return Object.keys(mounts).map((guest) => [
    guest,
    guest
      .replace(/\//g, ' ')
      .trim()
      .replace(/[^\w-]/g, '-')
  ])
}
