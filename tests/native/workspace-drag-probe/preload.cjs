const { contextBridge, ipcRenderer, webUtils } = require('electron')
contextBridge.exposeInMainWorld('probe', Object.freeze({
  info: () => ipcRenderer.invoke('probe:info'),
  start: id => { if (['markdown', 'text', 'code'].includes(id)) ipcRenderer.send('probe:begin', id) },
  checkpoint: () => ipcRenderer.invoke('probe:checkpoint'),
  quit: () => ipcRenderer.send('probe:quit'),
}))
let lastOver = 0
for (const type of ['pointerdown', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
  document.addEventListener(type, event => {
    if (type === 'dragover' && performance.now() - lastOver < 150) return
    if (type === 'dragover') lastOver = performance.now()
    const row = event.target instanceof Element ? event.target.closest('[data-id]') : null
    const transfer = event.dataTransfer
    const paths = type === 'drop' && transfer ? Array.from(transfer.files).map(file => webUtils.getPathForFile(file)) : []
    ipcRenderer.send('probe:telemetry', { event: type, id: row?.dataset.id, rendererTime: performance.now(),
      clientX: event.clientX, clientY: event.clientY,
      targetId: event.target instanceof Element ? event.target.id : '',
      prevented: event.defaultPrevented,
      mode: row?.dataset.mode, paths, trusted: event.isTrusted,
      types: transfer ? Array.from(transfer.types) : [],
      effectAllowed: transfer?.effectAllowed, dropEffect: transfer?.dropEffect,
      ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey })
  }, false)
}
