import readline from 'node:readline'
process.stdout.write('{"ready":true,"protocol":2}\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line)
  if (input.mode === 'hang') return
  if (input.mode === 'exit') process.exit(0)
  if (input.mode === 'wrong') { process.stdout.write(JSON.stringify({ id: input.id + 1, ok: true, result: {} }) + '\n'); return }
  process.stdout.write(JSON.stringify({ id: input.id, ok: true, result: { pid: process.pid, text: '中文与日本語', configured: true } }) + '\n')
}).on('close', () => process.exit(0))
