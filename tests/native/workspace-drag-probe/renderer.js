const MIME = 'application/x-arkdown-workspace-entry'
const output = document.querySelector('#result')
window.probe.info().then(info => {
  document.querySelector('#info').textContent = JSON.stringify(info, null, 2)
  for (const mode of ['html', 'native']) {
    for (const file of info.files) {
      const row = document.createElement('button')
      row.textContent = file.name
      row.dataset.id = file.id
      row.dataset.mode = mode
      row.draggable = true
      row.addEventListener('dragstart', event => {
        event.dataTransfer.effectAllowed = 'link'
        event.dataTransfer.setData(MIME, JSON.stringify({ workspace: info.sourceRoot, relativePath: file.name, kind: 'document' }))
        if (mode === 'native') { event.preventDefault(); window.probe.start(file.id) }
      })
      document.querySelector(`#${mode}-rows`).append(row)
    }
  }
})
const target = document.querySelector('#target')
target.addEventListener('dragenter', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'link' })
target.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'link' })
target.addEventListener('drop', event => {
  event.preventDefault()
  // Deliberately omit paths and content: preload records matching synthetic IDs.
  output.textContent = JSON.stringify({ event: 'drop', types: Array.from(event.dataTransfer.types),
    count: event.dataTransfer.files.length, effectAllowed: event.dataTransfer.effectAllowed,
    dropEffect: event.dataTransfer.dropEffect, trusted: event.isTrusted }, null, 2)
})
document.querySelector('#checkpoint').addEventListener('click', async () => {
  output.textContent = JSON.stringify(await window.probe.checkpoint(), null, 2)
})
document.querySelector('#quit').addEventListener('click', () => window.probe.quit())
