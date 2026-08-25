// Resolves a virtio-serial port device by the name the host gave it. The
// vportNpM numbering comes from a global virtio index, so it shifts whenever a
// device is added, and the name only lands in sysfs once the host's control
// message arrives — hence the poll.
module.exports = `#!/bin/sh

for i in $(seq 200); do
  for d in /sys/class/virtio-ports/*; do
    [ -r "$d/name" ] || continue
    [ "$(cat "$d/name")" = "$1" ] && { echo "/dev/\${d##*/}"; exit 0; }
  done
  sleep 0.05
done

exit 1
`
