const { contextBridge, ipcRenderer, webUtils } = require('electron')
contextBridge.exposeInMainWorld('cutflow', {
  filePath: file => webUtils.getPathForFile(file),
  mediaUrl: filePath => `cutflow-media://local/${encodeURIComponent(filePath)}`,
  openVideos: () => ipcRenderer.invoke('open-videos'),
  openMedia: () => ipcRenderer.invoke('open-media'),
  openAudio: () => ipcRenderer.invoke('open-audio'),
  openImages: () => ipcRenderer.invoke('open-images'),
  chooseOutputDir: () => ipcRenderer.invoke('choose-output-dir'),
  chooseLut: () => ipcRenderer.invoke('choose-lut'),
  getLutData: lut => ipcRenderer.invoke('get-lut-data', lut),
  prepareMedia: path => ipcRenderer.invoke('prepare-media', path),
  getThumbnail: (path, at = 0) => ipcRenderer.invoke('get-thumbnail', { path, at }),
  getWaveform: (path, points = 1600) => ipcRenderer.invoke('get-waveform', { path, points }),
  chooseOutput: (kind, format, suggestedName) => ipcRenderer.invoke('choose-output', { kind, format, suggestedName }),
  exportMedia: (payload) => ipcRenderer.invoke('export-media', payload),
  exportImages: (payload) => ipcRenderer.invoke('export-images', payload),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  onProgress: (callback) => {
    const listener = (_, value) => callback(value)
    ipcRenderer.on('export-progress', listener)
    return () => ipcRenderer.removeListener('export-progress', listener)
  },
  onProxyReady: (callback) => {
    const listener = (_, value) => callback(value)
    ipcRenderer.on('media-proxy-ready', listener)
    return () => ipcRenderer.removeListener('media-proxy-ready', listener)
  },
  onProbed: (callback) => {
    const listener = (_, value) => callback(value)
    ipcRenderer.on('media-probed', listener)
    return () => ipcRenderer.removeListener('media-probed', listener)
  },
  windowMinimize: () => ipcRenderer.invoke('window-control', 'minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-control', 'maximize'),
  windowClose: () => ipcRenderer.invoke('window-control', 'close')
})
