const { app, BrowserWindow, dialog, ipcMain, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')

let mainWindow
let exportProcess
const proxyJobs = new Map()
const proxyQueue = []
let activeProxyPath = null
const mediaProbeCache = new Map()
const mediaProbePending = new Map()
const mediaProbeQueue = []
let activeMediaProbes = 0
const MAX_MEDIA_PROBES = 3
const lutDataCache = new Map()
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mxf', '.mts', '.m2ts', '.m2t', '.ts', '.mpg', '.mpeg', '.vob', '.3gp'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])

protocol.registerSchemesAsPrivileged([{ scheme: 'cutflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1050, minHeight: 700,
    backgroundColor: '#0b0d12', frame: false, title: '剪影工坊 v1.53',
    show: process.env.CUTFLOW_SMOKE !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: process.env.CUTFLOW_SMOKE !== '1'
    }
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  if (process.env.CUTFLOW_SMOKE === '1') {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { smoke: '1' } })
    mainWindow.webContents.once('did-finish-load', () => {
      const probeMediaRange = async filePath => {
        const response = await serveMediaRange(new Request(`cutflow-media://local/${encodeURIComponent(filePath)}`, { headers: { Range: 'bytes=0-127' } }))
        return { status: response.status, range: response.headers.get('content-range'), bytes: (await response.arrayBuffer()).byteLength }
      }
      require('./smoke.cjs')({ app, mainWindow, fs, path, probeMediaRange, inspectMedia }).catch(error => {
        const message = `CUTFLOW_SMOKE_ERROR=${error?.stack || error}\n`
        process.stderr.write(message)
        if (process.env.CUTFLOW_SMOKE_LOG) fs.writeFileSync(process.env.CUTFLOW_SMOKE_LOG, message)
        app.exit(1)
      })
    })
  } else if (!app.isPackaged) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

ipcMain.handle('window-control', (_, action) => {
  if (action === 'minimize') mainWindow?.minimize()
  if (action === 'maximize') { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); return mainWindow?.isMaximized() }
  if (action === 'close') mainWindow?.close()
})

function ffmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return require('ffmpeg-static')
}

const BUILT_IN_LUTS = {
  'sony-slog3': 'sony-slog3-sgamut3cine-rec709.cube',
  'sony-slog2': 'sony-slog2-sgamut-rec709.cube',
  'panasonic-vlog': 'panasonic-vlog-vgamut-v709.cube'
}

function bundledLutPath(fileName) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'luts', fileName)
    : path.join(__dirname, '..', 'assets', 'luts', fileName)
}

function resolveLutPath(lut) {
  if (!lut || lut.preset === 'none') return null
  const builtInName = BUILT_IN_LUTS[lut.preset]
  const resolved = lut.preset === 'custom' ? lut.path : builtInName ? bundledLutPath(builtInName) : null
  if (!resolved || path.extname(resolved).toLowerCase() !== '.cube' || !fs.existsSync(resolved)) {
    throw new Error('LUT 文件不存在或不是 .cube 格式')
  }
  return resolved
}

function lutFilter(lut) {
  const lutPath = resolveLutPath(lut)
  if (!lutPath) return null
  const escaped = lutPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return `lut3d=file='${escaped}':interp=tetrahedral`
}

function parseCubeLut(lut) {
  const filePath = resolveLutPath(lut)
  if (!filePath) return { ok: true, size: 0, data: null }
  const stat = fs.statSync(filePath)
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`
  const cached = lutDataCache.get(cacheKey)
  if (cached) return cached
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  let size = 0
  let domainMin = [0, 0, 0]
  let domainMax = [1, 1, 1]
  const values = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || /^TITLE\b/i.test(line)) continue
    const parts = line.split(/\s+/)
    if (/^LUT_3D_SIZE$/i.test(parts[0])) { size = Number(parts[1]); continue }
    if (/^DOMAIN_MIN$/i.test(parts[0])) { domainMin = parts.slice(1, 4).map(Number); continue }
    if (/^DOMAIN_MAX$/i.test(parts[0])) { domainMax = parts.slice(1, 4).map(Number); continue }
    if (/^LUT_1D_SIZE$/i.test(parts[0])) throw new Error('暂不支持 1D LUT，请选择 3D .cube 文件')
    if (parts.length >= 3 && parts.slice(0, 3).every(value => Number.isFinite(Number(value)))) values.push(parts.slice(0, 3).map(Number))
  }
  const expected = size ** 3
  if (!Number.isInteger(size) || size < 2 || values.length < expected) throw new Error('LUT 数据不完整或 LUT_3D_SIZE 无效')
  const rgba = Buffer.allocUnsafe(expected * 4)
  for (let i = 0; i < expected; i++) {
    const value = values[i]
    rgba[i * 4] = Math.round(Math.max(0, Math.min(1, value[0])) * 255)
    rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, value[1])) * 255)
    rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, value[2])) * 255)
    rgba[i * 4 + 3] = 255
  }
  const result = { ok: true, size, domainMin, domainMax, data: rgba }
  lutDataCache.clear()
  lutDataCache.set(cacheKey, result)
  return result
}

ipcMain.handle('get-lut-data', (_, lut) => {
  try { return parseCubeLut(lut) }
  catch (error) { return { ok: false, error: error.message } }
})

ipcMain.handle('open-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频与相机素材', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mxf', 'mts', 'm2ts', 'm2t', 'ts', 'mpg', 'mpeg', 'vob', '3gp'] }]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('open-media', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频、音频或图片', extensions: ['mp4','mov','mkv','avi','webm','m4v','mxf','mts','m2ts','m2t','ts','mpg','mpeg','mp3','wav','m4a','aac','flac','ogg','jpg','jpeg','png','webp','bmp','gif'] }]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('open-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('open-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('choose-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('choose-lut', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '3D LUT', extensions: ['cube'] }]
  })
  return result.canceled ? null : result.filePaths[0]
})

function inspectMedia(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true })
    let log = ''
    proc.stderr.on('data', chunk => { log += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', () => {
      const duration = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      const video = log.match(/Video:\s*([^,\s]+)/)
      const audio = log.match(/Audio:\s*([^,\s]+)/)
      const size = log.match(/Video:[^\r\n]*,\s*(\d{2,5})x(\d{2,5})/)
      const pixelFormat = log.match(/Video:[^\r\n]*,\s*((?:yuva?|gbr|rgba|bgra|argb|abgr)[^,\s(]*)/i)
      if (!duration) return reject(new Error('无法读取该媒体文件的时长'))
      const audioByExtension = AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
      const mediaType = audioByExtension || !video ? 'audio' : 'video'
      resolve({
        duration: +duration[1] * 3600 + +duration[2] * 60 + +duration[3],
        mediaType, codec: (mediaType === 'audio' ? audio?.[1] : video?.[1] || '').toLowerCase(),
        hasAudio: Boolean(audio),
        pixelFormat: mediaType === 'video' ? (pixelFormat?.[1] || '').toLowerCase() : '',
        width: mediaType === 'video' ? +(size?.[1] || 0) : 0, height: mediaType === 'video' ? +(size?.[2] || 0) : 0
      })
    })
  })
}

function startNextPreviewProxy() {
  if (activeProxyPath || !proxyQueue.length) return
  const { filePath, info, previewPath } = proxyQueue.shift()
  activeProxyPath = filePath
  const partialPath = `${previewPath}.partial-${crypto.randomUUID()}`
  const args = info.mediaType === 'video'
    ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=w=min(960\\,iw):h=-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', partialPath]
    : ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'wav', partialPath]
  const proc = spawn(ffmpegPath(), args, { windowsHide: true })
  proxyJobs.set(filePath, proc)
  let error = ''
  proc.stderr.on('data', chunk => { error += chunk.toString() })
  proc.on('error', proxyError => {
    proxyJobs.delete(filePath)
    activeProxyPath = null
    fs.rmSync(partialPath, { force: true })
    mainWindow?.webContents.send('media-proxy-ready', { path: filePath, error: proxyError.message })
    startNextPreviewProxy()
  })
  proc.on('close', code => {
    if (!proxyJobs.has(filePath)) return
    proxyJobs.delete(filePath)
    activeProxyPath = null
    if (code === 0 && fs.existsSync(partialPath) && fs.statSync(partialPath).size > 0) {
      fs.renameSync(partialPath, previewPath)
      mainWindow?.webContents.send('media-proxy-ready', { path: filePath, previewPath, previewBytes: fs.statSync(previewPath).size })
    } else {
      fs.rmSync(partialPath, { force: true })
      mainWindow?.webContents.send('media-proxy-ready', { path: filePath, error: error.slice(-600) || '预览代理生成失败' })
    }
    startNextPreviewProxy()
  })
}

function createPreviewProxy(filePath, info, previewPath) {
  if (proxyJobs.has(filePath)) return
  proxyJobs.set(filePath, null)
  proxyQueue.push({ filePath, info, previewPath })
  startNextPreviewProxy()
}

function prepareProbedMedia(filePath, info, stat) {
  const extension = path.extname(filePath).toLowerCase()
  const nativeVideo = ['.mp4', '.m4v', '.mov', '.webm'].includes(extension) && ['h264', 'vp8', 'vp9', 'av1'].includes(info.codec)
  const needsVideoProxy = info.mediaType === 'video' && !nativeVideo
  const needsAudioProxy = info.mediaType === 'audio' && ['flac', 'alac', 'pcm_s24le', 'pcm_s32le'].includes(info.codec)
  if (!needsVideoProxy && !needsAudioProxy) return { ...info, previewPath: filePath, proxied: false, proxyPending: false }
  const key = crypto.createHash('sha1').update(`proxy-v4-background:${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex')
  const cacheDir = path.join(app.getPath('userData'), 'preview-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const previewPath = path.join(cacheDir, `${key}.${info.mediaType === 'video' ? 'mp4' : 'wav'}`)
  const cachedPreviewValid = fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0
  if (cachedPreviewValid) return { ...info, previewPath, previewBytes: fs.statSync(previewPath).size, proxied: true, proxyPending: false }
  createPreviewProxy(filePath, info, previewPath)
  return { ...info, previewPath: filePath, proxied: false, proxyPending: true }
}

function sendMediaProbed(result) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('media-probed', result)
}

function startNextMediaProbe() {
  while (activeMediaProbes < MAX_MEDIA_PROBES && mediaProbeQueue.length) {
    const job = mediaProbeQueue.shift()
    activeMediaProbes += 1
    inspectMedia(job.filePath)
      .then(info => {
        const prepared = prepareProbedMedia(job.filePath, info, job.stat)
        mediaProbeCache.set(job.filePath, { signature: job.signature, info })
        sendMediaProbed({ path: job.filePath, info: prepared })
      })
      .catch(error => sendMediaProbed({ path: job.filePath, error: error.message }))
      .finally(() => {
        activeMediaProbes -= 1
        mediaProbePending.delete(job.filePath)
        startNextMediaProbe()
      })
  }
}

function queueMediaProbe(filePath, stat) {
  const signature = `${stat.size}:${stat.mtimeMs}`
  const cached = mediaProbeCache.get(filePath)
  if (cached?.signature === signature) {
    setImmediate(() => sendMediaProbed({ path: filePath, info: prepareProbedMedia(filePath, cached.info, stat) }))
    return
  }
  if (mediaProbePending.get(filePath) === signature) return
  mediaProbePending.set(filePath, signature)
  mediaProbeQueue.push({ filePath, stat, signature })
  startNextMediaProbe()
}

ipcMain.handle('prepare-media', (_, filePath) => {
  try {
    const extension = path.extname(filePath).toLowerCase()
    const mediaType = VIDEO_EXTENSIONS.has(extension) ? 'video' : AUDIO_EXTENSIONS.has(extension) ? 'audio' : null
    if (!mediaType) throw new Error('不支持的文件格式')
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('素材路径不是文件')
    queueMediaProbe(filePath, stat)
    return {
      ok: true, mediaType, duration: 0, width: 0, height: 0,
      hasAudio: mediaType === 'audio' ? true : null,
      previewPath: filePath, proxied: false, proxyPending: false, pendingProbe: true
    }
  } catch (error) { return { ok: false, error: error.message } }
})

ipcMain.handle('get-thumbnail', async (_, { path: filePath, at }) => {
  const tempFile = path.join(os.tmpdir(), `cutflow-thumb-${crypto.randomUUID()}.jpg`)
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', tempFile], { windowsHide: true })
      let error = ''
      proc.stderr.on('data', chunk => { error += chunk.toString() })
      proc.on('error', reject)
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(error || '首帧提取失败')))
    })
    return { ok: true, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(tempFile).toString('base64')}` }
  } catch (error) { return { ok: false, error: error.message } }
  finally { fs.rmSync(tempFile, { force: true }) }
})

ipcMain.handle('get-waveform', async (_, { path: filePath, points }) => {
  try {
    const chunks = []
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { windowsHide: true })
      let error = ''
      proc.stdout.on('data', chunk => chunks.push(chunk))
      proc.stderr.on('data', chunk => { error += chunk.toString() })
      proc.on('error', reject)
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(error || '波形分析失败')))
    })
    const raw = Buffer.concat(chunks)
    const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
    const count = Math.max(200, Math.min(4000, points || 1600)), step = Math.max(1, Math.floor(samples.length / count)), peaks = []
    for (let i = 0; i < count; i++) {
      let peak = 0, rms = 0, seen = 0
      for (let j = i * step; j < Math.min(samples.length, (i + 1) * step); j += Math.max(1, Math.floor(step / 80))) { const value = Math.abs(samples[j]); peak = Math.max(peak, value); rms += value * value; seen++ }
      peaks.push(Math.min(1, Math.max(0.015, peak * .72 + Math.sqrt(rms / Math.max(1, seen)) * .55)))
    }
    return { ok: true, peaks }
  } catch (error) { return { ok: false, error: error.message } }
})

function sanitizeOutputName(suggestedName, ext) {
  const fallback = `剪影导出_${Date.now()}`
  let name = path.basename(String(suggestedName || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  if (name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) name = name.slice(0, -(ext.length + 1))
  name = name.replace(/[. ]+$/g, '').trim()
  if (!name) name = fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`
  return `${name}.${ext}`
}

ipcMain.handle('choose-output', async (_, { kind, format, suggestedName }) => {
  const audioFormat = String(format || 'mp3').toLowerCase()
  const videoFormat = String(format || 'mp4').toLowerCase()
  const imageFormat = String(format || 'jpg').toLowerCase()
  const ext = kind === 'image' && ['jpg', 'png', 'webp', 'bmp', 'tiff'].includes(imageFormat)
    ? imageFormat
    : kind === 'audio' && ['mp3', 'wav', 'm4a'].includes(audioFormat)
    ? audioFormat
    : ['mov', 'mov-alpha'].includes(videoFormat) ? 'mov' : 'mp4'
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: sanitizeOutputName(suggestedName, ext),
    filters: [{ name: kind === 'image' ? '图片' : kind === 'audio' ? '音频' : '视频', extensions: [ext] }]
  })
  return result.canceled ? null : result.filePath
})

function gainLinear(value, dbKey, legacyPercentKey) {
  const dbValue = value?.[dbKey]
  if (dbValue !== undefined && dbValue !== null && dbValue !== '' && Number.isFinite(Number(dbValue))) {
    const db = Number(dbValue)
    return db <= -120 ? 0 : Math.pow(10, Math.min(100, db) / 20)
  }
  const percent = Number(value?.[legacyPercentKey] ?? 100)
  return Number.isFinite(percent) ? Math.max(0, percent / 100) : 1
}

function audioFilter(clip, settings, { clipGain = true, masterGain = true, normalize = true } = {}) {
  let gain = 1
  if (clipGain) gain *= gainLinear(clip, 'gainDb', 'volume')
  if (masterGain) gain *= gainLinear(settings, 'masterGainDb', 'masterVolume')
  const filters = [`volume=${Number(gain.toFixed(8))}`]
  // Apply all requested gain before loudness normalization so the LUFS target
  // is measured from the adjusted signal.
  if (normalize && settings.normalizeAudio) filters.push(`loudnorm=I=${Number(settings.loudnessTarget) || -16}:LRA=11:TP=-1.5`)
  return filters.join(',')
}

function even(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2)
}

function outputVideoSize(clips, settings) {
  const source = clips.find(clip => clip.mediaType === 'video') || {}
  let width = Number(source.width) || 1920
  let height = Number(source.height) || 1080
  if (settings.ratio && settings.ratio !== 'original') {
    const [rw, rh] = String(settings.ratio).split(':').map(Number)
    const ratio = rw > 0 && rh > 0 ? rw / rh : width / height
    if (settings.ratioMode === 'pad') {
      if (width / height > ratio) height = width / ratio
      else width = height * ratio
    } else {
      if (width / height > ratio) width = height * ratio
      else height = width / ratio
    }
  }
  if (settings.resolution && settings.resolution !== 'original') {
    const requestedHeight = Number(String(settings.resolution).replace('p', ''))
    if (requestedHeight > 0) {
      width = width / height * requestedHeight
      height = requestedHeight
    }
  }
  return { width: even(width), height: even(height) }
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    exportProcess = spawn(ffmpegPath(), ['-y', ...args], { windowsHide: true })
    let log = ''
    exportProcess.stderr.on('data', chunk => {
      const line = chunk.toString(); log += line
      const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (match && duration) {
        const seconds = +match[1] * 3600 + +match[2] * 60 + +match[3]
        onProgress?.(Math.max(0, Math.min(1, seconds / duration)))
      }
    })
    exportProcess.on('error', reject)
    exportProcess.on('close', code => {
      exportProcess = null
      if (code === 0) { onProgress?.(1); resolve() }
      else reject(new Error(code === null ? '导出已取消' : `FFmpeg 导出失败 (${code})\n${log.slice(-1200)}`))
    })
  })
}

function createExportProgress(totalWeight) {
  const total = Math.max(0.001, totalWeight)
  let completed = 0
  let lastValue = 0
  const emit = fraction => {
    const value = Math.max(lastValue, Math.min(100, Math.round(fraction * 100)))
    lastValue = value
    mainWindow?.webContents.send('export-progress', value)
  }
  emit(0)
  return {
    async run(args, duration, weight = duration) {
      const safeWeight = Math.max(0.001, Number(weight) || 0.001)
      const start = completed
      await runFfmpeg(args, duration, fraction => emit((start + safeWeight * fraction) / total))
      completed += safeWeight
      emit(completed / total)
    },
    finish() { completed = total; emit(1) }
  }
}

ipcMain.handle('cancel-export', () => { if (exportProcess) exportProcess.kill(); return true })

ipcMain.handle('export-media', async (_, payload) => {
  const { clips, output, mode, settings } = payload
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutflow-'))
  try {
    const trimmed = []
    const totalDuration = clips.reduce((n, c) => n + c.end - c.start, 0)
    const audioOnly = clips.every(c => c.mediaType === 'audio')
    const videoFormat = ['mov', 'mov-alpha'].includes(settings.videoFormat) ? settings.videoFormat : 'mp4'
    const passCount = audioOnly && mode !== 'video' ? 3 : mode === 'video' && videoFormat === 'mov' ? 3 : mode === 'video' ? 2 : 3
    const exportProgress = createExportProgress(Math.max(0.001, totalDuration) * passCount)
    const runExport = (args, duration, weight = duration) => exportProgress.run(args, duration, weight)
    if (audioOnly && mode !== 'video') {
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i]
        const file = path.join(tempDir, `audio-${i}.wav`)
        await runExport(['-ss', String(clip.start), '-t', String(clip.end - clip.start), '-i', clip.path, '-vn', '-af', audioFilter(clip, settings, { masterGain: false, normalize: false }), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', file], clip.end - clip.start)
        trimmed.push(file)
      }
      const audioList = path.join(tempDir, 'audio-list.txt')
      fs.writeFileSync(audioList, trimmed.map(p => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'))
      const mergedAudio = path.join(tempDir, 'merged.wav')
      await runExport(['-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', mergedAudio], totalDuration)
      const audioArgs = ['-i', mergedAudio, '-vn']
      audioArgs.push('-af', audioFilter(null, settings, { clipGain: false }))
      if (settings.audioFormat === 'mp3') audioArgs.push('-c:a', 'libmp3lame', '-b:a', `${settings.audioBitrate}k`)
      else if (settings.audioFormat === 'wav') audioArgs.push('-c:a', 'pcm_s16le')
      else audioArgs.push('-c:a', 'aac', '-b:a', `${settings.audioBitrate}k`)
      await runExport([...audioArgs, output], totalDuration)
      exportProgress.finish()
      return { ok: true }
    }
    const videoBitrate = Math.max(1000, Math.min(50000, Number(settings.bitrate) || 6000))
    const alphaOutput = videoFormat === 'mov-alpha'
    const intermediateExtension = alphaOutput ? 'mov' : 'mp4'
    const intermediateVideoArgs = alphaOutput
      ? ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoBitrate}k`, '-pix_fmt', 'yuv420p']
    const intermediateAudioArgs = alphaOutput
      ? ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
      : ['-c:a', 'aac', '-ar', '48000', '-ac', '2']
    const targetSize = outputVideoSize(clips, settings)
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const file = path.join(tempDir, `clip-${i}.${intermediateExtension}`)
      if (clip.mediaType === 'audio') {
        const duration = Math.max(0.01, clip.end - clip.start)
        const color = `color=c=${alphaOutput ? 'black@0.0' : 'black'}:s=${targetSize.width}x${targetSize.height}:r=${Number(settings.fps) || 30}:d=${duration}${alphaOutput ? ',format=yuva444p10le' : ''}`
        const args = ['-ss', String(clip.start), '-i', clip.path, '-f', 'lavfi', '-i', color, '-t', String(duration),
          '-map', '1:v:0', '-map', '0:a:0', ...intermediateVideoArgs,
          '-r', String(settings.fps || 30), '-af', audioFilter(clip, settings),
          ...intermediateAudioArgs, '-shortest', file]
        await runExport(args, duration)
        trimmed.push(file)
        continue
      }
      const vf = []
      const activeLut = lutFilter(clip.lut || settings.globalLut)
      if (activeLut) vf.push(activeLut)
      const transform = clip.transform || { scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }
      if (transform.rotation === 90) vf.push('transpose=1')
      if (transform.rotation === 180) vf.push('transpose=1,transpose=1')
      if (transform.rotation === 270) vf.push('transpose=2')
      if (transform.flipH) vf.push('hflip')
      if (transform.flipV) vf.push('vflip')
      const fillFrame = settings.ratio !== 'original' && settings.ratioMode !== 'pad'
      vf.push(`scale=${targetSize.width}:${targetSize.height}:force_original_aspect_ratio=${fillFrame ? 'increase' : 'decrease'}`)
      if (fillFrame) vf.push(`crop=${targetSize.width}:${targetSize.height}:(iw-${targetSize.width})/2:(ih-${targetSize.height})/2`)
      else vf.push(`pad=${targetSize.width}:${targetSize.height}:(ow-iw)/2:(oh-ih)/2:${alphaOutput ? 'black@0.0' : 'black'}`)
      const zoom = Math.max(0.1, Number(transform.scale || 100) / 100)
      const offsetX = Number(transform.x) || 0
      const offsetY = Number(transform.y) || 0
      if (Math.abs(zoom - 1) > 0.0001) {
        const zoomWidth = even(targetSize.width * zoom)
        const zoomHeight = even(targetSize.height * zoom)
        vf.push(`scale=${zoomWidth}:${zoomHeight}`)
        if (zoom >= 1) {
          vf.push(`crop=${targetSize.width}:${targetSize.height}:'max(0,min(iw-${targetSize.width},(iw-${targetSize.width})/2-${offsetX}))':'max(0,min(ih-${targetSize.height},(ih-${targetSize.height})/2-${offsetY}))'`)
        } else {
          vf.push(`pad=${targetSize.width}:${targetSize.height}:'max(0,min(ow-iw,(ow-iw)/2+${offsetX}))':'max(0,min(oh-ih,(oh-ih)/2+${offsetY}))':${alphaOutput ? 'black@0.0' : 'black'}`)
        }
      }
      vf.push('setsar=1', `format=${alphaOutput ? 'yuva444p10le' : 'yuv420p'}`)
      const args = ['-ss', String(clip.start), '-t', String(clip.end - clip.start), '-i', clip.path,
        '-vf', vf.join(','), ...intermediateVideoArgs,
        '-r', String(settings.fps || 30), '-af', audioFilter(clip, settings),
        ...intermediateAudioArgs, file]
      await runExport(args, clip.end - clip.start)
      trimmed.push(file)
    }
    const list = path.join(tempDir, 'list.txt')
    fs.writeFileSync(list, trimmed.map(p => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'))
    const merged = path.join(tempDir, `merged.${intermediateExtension}`)
    const hasTransitions = clips.slice(0, -1).some(c => c.transition?.type && c.transition.type !== 'none')
    if (hasTransitions && clips.length > 1) {
      const args = trimmed.flatMap(file => ['-i', file]), filters = []
      let elapsed = clips[0].end - clips[0].start, videoIn = '[0:v]', audioIn = '[0:a]'
      for (let i = 1; i < clips.length; i++) {
        const transition = clips[i - 1].transition || {}, duration = transition.type && transition.type !== 'none' ? Math.max(.1, Math.min(3, transition.duration || .5)) : .04
        const type = transition.type && transition.type !== 'none' ? transition.type : 'fade', offset = Math.max(.01, elapsed - duration)
        filters.push(`${videoIn}[${i}:v]xfade=transition=${type}:duration=${duration}:offset=${offset}[v${i}]`)
        filters.push(`${audioIn}[${i}:a]acrossfade=d=${duration}:c1=tri:c2=tri[a${i}]`)
        videoIn = `[v${i}]`; audioIn = `[a${i}]`; elapsed += clips[i].end - clips[i].start - duration
      }
      args.push('-filter_complex', filters.join(';'), '-map', videoIn, '-map', audioIn, ...intermediateVideoArgs, ...intermediateAudioArgs, merged)
      await runExport(args, elapsed, totalDuration)
    } else await runExport(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', merged], totalDuration)
    if (mode === 'video' && videoFormat === 'mp4') fs.copyFileSync(merged, output)
    else if (mode === 'video' && videoFormat === 'mov') {
      await runExport(['-i', merged, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', output], totalDuration)
    }
    else if (mode === 'video' && videoFormat === 'mov-alpha') fs.copyFileSync(merged, output)
    else {
      const audioArgs = ['-i', merged, '-vn']
      if (settings.audioFormat === 'mp3') audioArgs.push('-c:a', 'libmp3lame', '-b:a', `${settings.audioBitrate}k`)
      else if (settings.audioFormat === 'wav') audioArgs.push('-c:a', 'pcm_s16le')
      else audioArgs.push('-c:a', 'aac', '-b:a', `${settings.audioBitrate}k`)
      await runExport([...audioArgs, output], totalDuration)
    }
    exportProgress.finish()
    return { ok: true }
  } catch (error) { return { ok: false, error: error.message } }
  finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
})

function evenImageSize(value) {
  return Math.max(2, Math.round(Math.max(2, Number(value) || 2) / 2) * 2)
}

function imageFilterChain(item, settings) {
  const transform = item.transform || {}
  const rotation = ((Number(transform.rotation) || 0) % 360 + 360) % 360
  const filters = []
  if (rotation === 90) filters.push('transpose=1')
  else if (rotation === 180) filters.push('transpose=1,transpose=1')
  else if (rotation === 270) filters.push('transpose=2')
  else if (rotation !== 0) filters.push(`rotate=${rotation}*PI/180:ow=rotw(iw):oh=roth(ih):c=${['png', 'webp', 'tiff'].includes(settings.imageFormat) ? '0x00000000' : 'white'}`)

  const sourceWidth = Number(item.width)
  const sourceHeight = Number(item.height)
  const radians = rotation * Math.PI / 180
  let rotatedWidth = Math.abs(sourceWidth * Math.cos(radians)) + Math.abs(sourceHeight * Math.sin(radians))
  let rotatedHeight = Math.abs(sourceWidth * Math.sin(radians)) + Math.abs(sourceHeight * Math.cos(radians))
  const crop = item.crop
  if (crop && rotatedWidth > 0 && rotatedHeight > 0) {
    const cropWidthRatio = Math.max(0.01, Math.min(1, Number(crop.width) || 1))
    const cropHeightRatio = Math.max(0.01, Math.min(1, Number(crop.height) || 1))
    const cropXRatio = Math.max(0, Math.min(1, Number(crop.x) || 0))
    const cropYRatio = Math.max(0, Math.min(1, Number(crop.y) || 0))
    const cropWidth = evenImageSize(rotatedWidth * cropWidthRatio)
    const cropHeight = evenImageSize(rotatedHeight * cropHeightRatio)
    filters.push(`crop=w='max(2,trunc(iw*${cropWidthRatio}/2)*2)':h='max(2,trunc(ih*${cropHeightRatio}/2)*2)':x='max(0,min(iw-ow,iw*${cropXRatio}))':y='max(0,min(ih-oh,ih*${cropYRatio}))'`)
    rotatedWidth = cropWidth
    rotatedHeight = cropHeight
  }
  const useOriginalResolution = settings.imageResolutionPreset === 'original'
  const requestedWidth = useOriginalResolution ? 0 : Math.max(0, Number(settings.imageWidth) || 0)
  const requestedHeight = useOriginalResolution ? 0 : Math.max(0, Number(settings.imageHeight) || 0)
  const targetWidth = requestedWidth || evenImageSize(rotatedWidth)
  const targetHeight = requestedHeight || evenImageSize(rotatedHeight)
  const zoom = Math.max(0.1, Math.min(3, Number(transform.scale || 100) / 100))

  if (rotatedWidth > 0 && rotatedHeight > 0 && targetWidth > 0 && targetHeight > 0) {
    const fit = Math.min(targetWidth / rotatedWidth, targetHeight / rotatedHeight) * zoom
    const contentWidth = evenImageSize(rotatedWidth * fit)
    const contentHeight = evenImageSize(rotatedHeight * fit)
    const cropWidth = Math.min(contentWidth, targetWidth)
    const cropHeight = Math.min(contentHeight, targetHeight)
    filters.push(`scale=${contentWidth}:${contentHeight}`)
    if (cropWidth !== contentWidth || cropHeight !== contentHeight) filters.push(`crop=${cropWidth}:${cropHeight}:(iw-ow)/2:(ih-oh)/2`)
    const alphaOutput = ['png', 'webp', 'tiff'].includes(settings.imageFormat)
    if (alphaOutput) filters.push('format=rgba')
    if (cropWidth !== targetWidth || cropHeight !== targetHeight) filters.push(`pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:${alphaOutput ? '0x00000000' : 'white'}`)
  } else if (Math.abs(zoom - 1) > 0.0001) {
    filters.push(`scale='max(2,trunc(iw*${zoom}/2)*2)':'max(2,trunc(ih*${zoom}/2)*2)'`)
  }
  return filters
}

function encodeOneImage(item, settings, quality) {
  return new Promise((resolve, reject) => {
    const outputDirectory = path.dirname(path.resolve(item.output))
    if (!fs.existsSync(outputDirectory)) fs.mkdirSync(outputDirectory, { recursive: true })
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', item.path, '-frames:v', '1']
    const filters = imageFilterChain(item, settings)
    if (filters.length) args.push('-vf', filters.join(','))
    if (settings.imageFormat === 'jpg') args.push('-c:v', 'mjpeg', '-q:v', String(quality ?? 2), '-pix_fmt', 'yuvj444p')
    else if (settings.imageFormat === 'png') args.push('-c:v', 'png', '-compression_level', '9')
    else if (settings.imageFormat === 'webp') args.push('-c:v', 'libwebp', '-quality', String(quality ?? 92))
    else if (settings.imageFormat === 'bmp') args.push('-c:v', 'bmp')
    else args.push('-c:v', 'tiff', '-compression_algo', 'deflate')
    args.push(item.output)
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    exportProcess = proc
    let error = ''
    proc.stderr.on('data', chunk => { error += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', code => {
      exportProcess = null
      code === 0 ? resolve() : reject(new Error(error || '图片导出失败'))
    })
  })
}

async function exportOneImage(item, settings) {
  const targetBytes = Math.max(0, Number(settings.imageTargetSizeMb) || 0) * 1024 * 1024
  const qualities = settings.imageFormat === 'jpg'
    ? [2, 4, 7, 10, 14, 18, 23, 28, 31]
    : settings.imageFormat === 'webp' ? [92, 80, 68, 56, 44, 32, 20, 10] : [null]
  for (const quality of qualities) {
    await encodeOneImage(item, settings, quality)
    if (!targetBytes || fs.statSync(item.output).size <= targetBytes) break
  }
}

ipcMain.handle('export-images', async (_, payload) => {
  const items = Array.isArray(payload?.images) ? payload.images : []
  const settings = payload?.settings || {}
  if (!items.length) return { ok: false, error: '没有可导出的图片' }
  try {
    mainWindow?.webContents.send('export-progress', 0)
    for (let index = 0; index < items.length; index += 1) {
      await exportOneImage(items[index], settings)
      mainWindow?.webContents.send('export-progress', Math.round((index + 1) / items.length * 100))
    }
    return { ok: true, count: items.length }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

async function serveMediaRange(request) {
  const marker = 'cutflow-media://local/'
  try {
    const filePath = decodeURIComponent(request.url.slice(marker.length))
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) return new Response('媒体文件不存在或为空', { status: 404 })
    const response = await net.fetch(pathToFileURL(filePath).toString(), {
      method: request.method,
      headers: request.headers
    })
    const range = request.headers.get('range')
    if (!range) {
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Accept-Ranges', 'bytes')
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
    }
    const match = range.match(/^bytes=(\d*)-(\d*)$/i)
    if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0))
    let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1
    end = Math.min(stat.size - 1, end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    const headers = new Headers(response.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(request.method === 'HEAD' ? null : response.body, { status: 206, headers })
  } catch (error) {
    return new Response(`媒体读取失败：${error.message}`, { status: 404 })
  }
}

app.whenReady().then(() => {
  protocol.handle('cutflow-media', serveMediaRange)
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
