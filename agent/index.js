const { spawn } = require('child_process')
const net = require('net')

module.exports = function serve(path) {
  const server = net.createServer(onconnection)
  server.listen(path)
  return server
}

function onconnection(socket) {
  let buffer = ''

  socket.on('error', () => socket.destroy())
  socket.on('data', (data) => {
    buffer += data.toString()

    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      onrequest(socket, JSON.parse(line))
    }
  })
}

function onrequest(socket, { id, method, params }) {
  if (method === 'ping') return send(socket, { id, result: 'pong' })
  if (method === 'exec') return exec(socket, id, params)
  send(socket, { id, error: 'Unknown method: ' + method })
}

function exec(socket, id, { command, cwd, env }) {
  const child = spawn('sh', ['-c', command], { cwd, env })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })

  child.on('error', (err) => send(socket, { id, error: err.message }))
  child.on('close', (exitCode, signal) =>
    send(socket, { id, result: { exitCode, signal, stdout, stderr } })
  )
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n')
}
