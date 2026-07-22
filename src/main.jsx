import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Upload, Play, Pause, Scissors, GripVertical, Music2, Settings2,
  Download, Plus, X, CheckCircle2, FolderOpen, RotateCw, FlipHorizontal2,
  FlipVertical2, ZoomIn, LogIn, LogOut, AudioWaveform, Video, Minus,
  Maximize2, Minimize2, RotateCcw, Images
} from 'lucide-react'
import './styles.css'

const api = window.cutflow || {
  filePath: file => file.path,
  mediaUrl: path => `file://${path}`,
  openMedia: async () => [],
  openAudio: async () => [],
  openImages: async () => [],
  chooseOutputDir: async () => null,
  chooseLut: async () => null,
  getLutData: async () => ({ ok: false, error: '桌面应用未连接' }),
  prepareMedia: async path => ({ ok: true, previewPath: path }),
  getThumbnail: async () => ({ ok: false }),
  getWaveform: async () => ({ ok: false }),
  chooseOutput: async () => null,
  exportMedia: async () => ({ ok: false, error: '请在桌面应用中运行' }),
  exportImages: async () => ({ ok: false, error: '请在桌面应用中运行' }),
  cancelExport: async () => {},
  onProgress: () => () => {},
  onProxyReady: () => () => {},
  onProbed: () => () => {},
  windowMinimize: () => {},
  windowMaximize: () => {},
  windowClose: () => {}
}

const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|m4v|mxf|mts|m2ts|m2t|ts|mpg|mpeg|vob|3gp)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg)$/i
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|bmp|gif)$/i
const fileName = path => path.split(/[\\/]/).pop()
const baseName = path => fileName(path).replace(/\.[^.]+$/, '')
const safeName = value => (value || '时间轴').replace(/[<>:"/\\|?*]/g, '_').trim() || '时间轴'
const outputBaseName = (timeline, namingMode) => safeName(namingMode === 'firstClip'
  ? baseName(timeline?.clips?.[0]?.name || timeline?.name)
  : timeline?.name)
const clipSupportsExport = (clip, mode) => mode === 'video'
  ? clip.mediaType === 'video'
  : clip.mediaType === 'audio' || clip.hasAudio !== false
const buildExportJobs = (timelines, mode, settings) => {
  const unit = mode === 'video' ? settings.videoExportUnit : settings.audioExportUnit
  const usedNames = new Map()
  const uniqueName = value => {
    const base = safeName(value)
    const duplicateIndex = usedNames.get(base) || 0
    usedNames.set(base, duplicateIndex + 1)
    return duplicateIndex ? `${base}_${duplicateIndex + 1}` : base
  }
  if (unit === 'clip') {
    return timelines.flatMap(timeline => timeline.clips
      .filter(clip => clipSupportsExport(clip, mode))
      .map(clip => ({ timeline, clips: [clip], name: uniqueName(baseName(clip.name || clip.path)) })))
  }
  return timelines
    .filter(timeline => timeline.clips.some(clip => clipSupportsExport(clip, mode)))
    .map(timeline => ({
      timeline,
      clips: mode === 'audio' ? timeline.clips.filter(clip => clipSupportsExport(clip, mode)) : timeline.clips,
      name: uniqueName(outputBaseName(timeline, settings.namingMode))
    }))
}
const buildImageExportItems = (images, directory, format) => {
  const usedNames = new Map()
  const separator = directory?.includes('\\') ? '\\' : '/'
  const normalizedDirectory = directory ? directory.replace(/[\\/]+$/, '') : ''
  return images.map(image => {
    const base = safeName(baseName(image.name || image.path))
    const duplicateIndex = usedNames.get(base) || 0
    usedNames.set(base, duplicateIndex + 1)
    const name = duplicateIndex ? `${base}_${duplicateIndex + 1}` : base
    return {
      ...image,
      name,
      output: directory ? `${normalizedDirectory}${separator}${name}.${format}` : ''
    }
  })
}
const timelineClipWidth = duration => Math.floor(Math.max(185, Math.min(277.5, (Number(duration) || 0) * 18.5)))
const fmt = seconds => {
  const value = Math.max(0, Number(seconds) || 0)
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}.${Math.floor(value % 1 * 10)}`
}
const timelineKind = clips => {
  const video = clips.some(clip => clip.mediaType === 'video')
  const audio = clips.some(clip => clip.mediaType === 'audio')
  return video && audio ? '混合' : audio ? '音频' : video ? '视频' : '空白'
}

function useMediaTimeController({ clip, marks, setTime, setPlaying, setPreviewStatus, show }) {
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  const clipRef = useRef(clip)
  const marksRef = useRef(marks)
  const timeRef = useRef(clip?.start || 0)
  const scrubbingRef = useRef(false)
  const scrubTargetRef = useRef(null)
  const settlingTargetRef = useRef(null)
  const pendingSeekRef = useRef(null)
  const writeFrameRef = useRef(0)
  const playbackFrameRef = useRef(0)
  const listenersRef = useRef(new Set())
  const firstFrameRef = useRef(null)
  const primedClipRef = useRef(null)
  const metricsRef = useRef({ seeks: 0, videoLoads: 0, audioLoads: 0, firstFrames: 0, errors: [] })

  clipRef.current = clip
  marksRef.current = marks

  const activeElement = () => clipRef.current?.mediaType === 'audio' ? audioRef.current : videoRef.current
  const clampTime = value => {
    const activeClip = clipRef.current
    if (!activeClip) return 0
    const elementDuration = activeElement()?.duration
    const playableEnd = Number.isFinite(elementDuration) && elementDuration > 0
      ? Math.min(activeClip.end, elementDuration)
      : activeClip.end
    return Math.max(activeClip.start, Math.min(playableEnd, Number(value) || 0))
  }
  const notify = value => {
    timeRef.current = value
    listenersRef.current.forEach(listener => listener(value))
  }
  const refreshFrame = (element, target) => {
    if (element?.tagName === 'VIDEO' && typeof element.requestVideoFrameCallback === 'function') {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        if (scrubbingRef.current || settlingTargetRef.current != null) notify(scrubTargetRef.current ?? target)
      }
      element.requestVideoFrameCallback(done)
      window.setTimeout(done, 120)
    } else {
      requestAnimationFrame(() => notify(scrubTargetRef.current ?? target))
    }
  }
  const confirmVideoFrame = (element, callback) => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      callback()
    }
    if (typeof element.requestVideoFrameCallback === 'function') element.requestVideoFrameCallback(done)
    requestAnimationFrame(() => requestAnimationFrame(done))
  }
  const primeFirstFrame = element => {
    const activeClip = clipRef.current
    if (!activeClip || activeClip.mediaType !== 'video' || element !== videoRef.current) return
    if (primedClipRef.current === activeClip.id) return
    if (firstFrameRef.current?.clipId === activeClip.id && firstFrameRef.current.started) return
    const previewTime = activeClip.start <= 0
      ? Math.min(0.05, Math.max(0.001, (activeClip.duration || 0.1) / 2))
      : activeClip.start
    const queuedTarget = pendingSeekRef.current?.clipId === activeClip.id ? pendingSeekRef.current.target : activeClip.start
    firstFrameRef.current = { clipId: activeClip.id, previewTime, finalTime: queuedTarget, stage: 'preview', started: true }
    setPreviewStatus({ state: 'decoding', message: '正在解码首帧…' })
    if (Math.abs(element.currentTime - previewTime) < 0.0005 && element.readyState >= 2) {
      confirmVideoFrame(element, () => {
        const pending = firstFrameRef.current
        if (!pending || pending.clipId !== clipRef.current?.id) return
        if (pending.stage === 'preview' && Math.abs(pending.finalTime - pending.previewTime) > 0.0005) {
          pending.stage = 'final'
          try { element.currentTime = pending.finalTime } catch { /* keep the decoded frame */ }
          return
        }
        firstFrameRef.current = null
        pendingSeekRef.current = null
        primedClipRef.current = pending.clipId
        metricsRef.current.firstFrames += 1
        notify(pending.finalTime)
        setTime(pending.finalTime)
        setPreviewStatus({ state: 'ready', message: '' })
      })
      return
    }
    try {
      element.currentTime = previewTime
      metricsRef.current.seeks += 1
    } catch (error) {
      metricsRef.current.errors.push(error.message)
    }
  }
  const writeCurrentTime = target => {
    const element = activeElement()
    const activeClip = clipRef.current
    if (!element || !activeClip || element.dataset.clipId !== activeClip.id || element.readyState < 1) {
      if (activeClip) pendingSeekRef.current = { clipId: activeClip.id, target }
      return
    }
    try {
      element.currentTime = target
      metricsRef.current.seeks += 1
      refreshFrame(element, target)
    } catch (error) {
      metricsRef.current.errors.push(error.message)
    }
  }
  const seekTo = (value, { commit = false, immediate = false } = {}) => {
    const target = clampTime(value)
    const activeClip = clipRef.current
    if (activeClip && firstFrameRef.current?.clipId === activeClip.id) firstFrameRef.current.finalTime = target
    scrubTargetRef.current = target
    notify(target)
    cancelAnimationFrame(writeFrameRef.current)
    if (immediate) writeCurrentTime(target)
    else writeFrameRef.current = requestAnimationFrame(() => writeCurrentTime(scrubTargetRef.current))
    if (commit) setTime(target)
    return target
  }
  const pause = () => {
    videoRef.current?.pause()
    audioRef.current?.pause()
    setPlaying(false)
  }
  const beginScrub = () => {
    pause()
    scrubbingRef.current = true
    settlingTargetRef.current = null
  }
  const endScrub = () => {
    const target = scrubTargetRef.current ?? timeRef.current
    scrubbingRef.current = false
    settlingTargetRef.current = target
    seekTo(target, { commit: true, immediate: true })
    window.setTimeout(() => {
      if (settlingTargetRef.current === target) settlingTargetRef.current = null
    }, 240)
    return target
  }
  const stopAtOut = element => {
    const activeClip = clipRef.current
    if (!activeClip) return false
    const mediaDuration = element.duration
    const out = Math.min(activeClip.end, marksRef.current.out ?? activeClip.end, Number.isFinite(mediaDuration) ? mediaDuration : activeClip.end)
    if (element.currentTime < out - 0.006) return false
    element.pause()
    settlingTargetRef.current = out
    scrubTargetRef.current = out
    try { element.currentTime = out } catch { /* element can be unloading */ }
    notify(out)
    setTime(out)
    setPlaying(false)
    window.setTimeout(() => { if (settlingTargetRef.current === out) settlingTargetRef.current = null }, 160)
    return true
  }
  const playbackTick = () => {
    const element = activeElement()
    if (!element || element.paused || stopAtOut(element)) return
    notify(element.currentTime)
    playbackFrameRef.current = requestAnimationFrame(playbackTick)
  }
  const onPlay = event => {
    if (event.currentTarget !== activeElement()) return
    setPlaying(true)
    cancelAnimationFrame(playbackFrameRef.current)
    playbackFrameRef.current = requestAnimationFrame(playbackTick)
  }
  const onPause = event => {
    if (event.currentTarget !== activeElement()) return
    setPlaying(false)
    cancelAnimationFrame(playbackFrameRef.current)
  }
  const onTimeUpdate = event => {
    const element = event.currentTarget
    if (element !== activeElement() || scrubbingRef.current || settlingTargetRef.current != null || element.seeking) return
    if (!stopAtOut(element)) {
      notify(element.currentTime)
      setTime(element.currentTime)
    }
  }
  const onSeeked = event => {
    const element = event.currentTarget
    const firstFrame = firstFrameRef.current
    if (element === videoRef.current && firstFrame?.clipId === clipRef.current?.id) {
      confirmVideoFrame(element, () => {
        const pending = firstFrameRef.current
        if (!pending || pending.clipId !== clipRef.current?.id) return
        if (pending.stage === 'preview' && Math.abs(pending.finalTime - pending.previewTime) > 0.0005) {
          pending.stage = 'final'
          try { element.currentTime = pending.finalTime } catch { /* keep decoded preview frame */ }
          return
        }
        firstFrameRef.current = null
        pendingSeekRef.current = null
        primedClipRef.current = pending.clipId
        metricsRef.current.firstFrames += 1
        settlingTargetRef.current = null
        scrubTargetRef.current = pending.finalTime
        notify(pending.finalTime)
        setTime(pending.finalTime)
        setPreviewStatus({ state: 'ready', message: '' })
      })
      return
    }
    if (element !== activeElement() || scrubbingRef.current) return
    const target = settlingTargetRef.current
    if (target == null) return
    if (Math.abs(element.currentTime - target) > 0.025) {
      writeCurrentTime(target)
      return
    }
    settlingTargetRef.current = null
    notify(target)
    setTime(target)
  }
  const onLoadedMetadata = event => {
    const element = event.currentTarget
    const activeClip = clipRef.current
    if (!activeClip || element !== activeElement() || element.dataset.clipId !== activeClip.id) return
    if (activeClip.mediaType === 'video') {
      if (!element.videoWidth || !element.videoHeight) {
        setPreviewStatus({ state: 'error', message: '视频尺寸无效，无法显示预览' })
        return
      }
      setPreviewStatus({ state: 'loading', message: '媒体信息已读取，正在加载画面…' })
      primeFirstFrame(element)
      return
    }
    const target = pendingSeekRef.current?.clipId === activeClip.id ? pendingSeekRef.current.target : activeClip.start
    pendingSeekRef.current = null
    settlingTargetRef.current = target
    seekTo(target, { commit: true, immediate: true })
    setPreviewStatus({ state: 'ready', message: '' })
  }
  const onLoadedData = event => {
    if (event.currentTarget === videoRef.current && event.currentTarget.readyState >= 2) primeFirstFrame(event.currentTarget)
  }
  const onCanPlay = event => {
    if (event.currentTarget === videoRef.current && event.currentTarget.readyState >= 2) primeFirstFrame(event.currentTarget)
  }
  const onError = event => {
    const element = event.currentTarget
    if (!element.getAttribute('src')) return
    const message = `媒体预览加载失败（错误 ${element.error?.code || '未知'}）`
    metricsRef.current.errors.push(message)
    setPreviewStatus({ state: 'error', message })
    show(message)
  }
  const waitForPosition = (target, timeout = 1800) => new Promise(resolve => {
    const started = performance.now()
    const check = () => {
      const element = activeElement()
      if (element?.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - target) < 0.04) return resolve(true)
      if (performance.now() - started >= timeout) return resolve(false)
      requestAnimationFrame(check)
    }
    check()
  })
  const toggle = async () => {
    const activeClip = clipRef.current
    const element = activeElement()
    if (!activeClip || !element || element.dataset.clipId !== activeClip.id) return
    if (!element.paused) return element.pause()
    const entry = Math.max(activeClip.start, marksRef.current.in ?? activeClip.start)
    const exit = Math.min(activeClip.end, marksRef.current.out ?? activeClip.end)
    if (exit - entry < 0.04) return show('入出点区间太短，无法播放')
    if (element.currentTime < entry || element.currentTime >= exit - 0.02) {
      settlingTargetRef.current = entry
      seekTo(entry, { commit: true, immediate: true })
      await waitForPosition(entry)
      settlingTargetRef.current = null
    }
    try { await element.play() } catch (error) { show(`无法播放：${error.message}`) }
  }
  const playFromIn = async requestedMarks => {
    const activeClip = clipRef.current
    const element = activeElement()
    if (!activeClip || !element || element.dataset.clipId !== activeClip.id) return
    if (!element.paused) return element.pause()
    const activeMarks = requestedMarks || marksRef.current
    const entry = Math.max(activeClip.start, activeMarks.in ?? activeClip.start)
    const exit = Math.min(activeClip.end, activeMarks.out ?? activeClip.end)
    if (exit - entry < 0.04) return show('入出点区间太短，无法播放')
    element.pause()
    settlingTargetRef.current = entry
    seekTo(entry, { commit: true, immediate: true })
    let located = await waitForPosition(entry, 5000)
    if (!located) {
      try { element.currentTime = entry } catch { /* report below */ }
      located = await waitForPosition(entry, 5000)
    }
    if (!located) {
      settlingTargetRef.current = null
      setPreviewStatus({ state: 'error', message: '无法定位到入点，请重试或重新生成预览代理' })
      return show('无法定位到入点，已取消播放')
    }
    settlingTargetRef.current = null
    try { await element.play() } catch (error) { show(`无法播放：${error.message}`) }
  }
  const loadClip = nextClip => {
    pause()
    cancelAnimationFrame(writeFrameRef.current)
    cancelAnimationFrame(playbackFrameRef.current)
    scrubbingRef.current = false
    settlingTargetRef.current = null
    firstFrameRef.current = null
    primedClipRef.current = null
    pendingSeekRef.current = null
    scrubTargetRef.current = nextClip?.start ?? 0
    notify(nextClip?.start ?? 0)
    setTime(nextClip?.start ?? 0)
    const selectedElement = nextClip?.mediaType === 'audio' ? audioRef.current : videoRef.current
    const otherElement = nextClip?.mediaType === 'audio' ? videoRef.current : audioRef.current
    otherElement?.pause()
    if (!nextClip || !selectedElement) {
      setPreviewStatus({ state: 'idle', message: '' })
      return
    }
    setPreviewStatus({ state: 'loading', message: nextClip.mediaType === 'video' ? '正在加载视频…' : '正在加载音频…' })
    const url = api.mediaUrl(nextClip.previewPath || nextClip.path)
    selectedElement.dataset.clipId = nextClip.id
    if (selectedElement.dataset.mediaSource !== url) {
      selectedElement.dataset.mediaSource = url
      selectedElement.src = url
      selectedElement.load()
      if (nextClip.mediaType === 'audio') metricsRef.current.audioLoads += 1
      else metricsRef.current.videoLoads += 1
    } else if (selectedElement.readyState >= 1) {
      if (nextClip.mediaType === 'video') primeFirstFrame(selectedElement)
      else {
        settlingTargetRef.current = nextClip.start
        seekTo(nextClip.start, { commit: true, immediate: true })
        setPreviewStatus({ state: 'ready', message: '' })
      }
    }
  }
  const clearMedia = () => {
    pause()
    ;[videoRef.current, audioRef.current].forEach(element => {
      if (!element) return
      element.removeAttribute('src')
      delete element.dataset.mediaSource
      delete element.dataset.clipId
      element.load()
    })
    notify(0)
    setTime(0)
    setPreviewStatus({ state: 'idle', message: '' })
  }
  const subscribe = listener => {
    listenersRef.current.add(listener)
    listener(timeRef.current)
    return () => listenersRef.current.delete(listener)
  }
  return {
    videoRef, audioRef, seekTo, beginScrub, endScrub, pause, toggle, playFromIn,
    loadClip, clearMedia, subscribe, onPlay, onPause, onTimeUpdate,
    onSeeked, onLoadedMetadata, onLoadedData, onCanPlay, onError,
    getTime: () => timeRef.current,
    getMarks: () => marksRef.current,
    isScrubbing: () => scrubbingRef.current,
    metrics: metricsRef
  }
}

function App() {
  const firstTimeline = useRef({ id: crypto.randomUUID(), name: '时间轴 1', clips: [] })
  const [timelines, setTimelines] = useState([firstTimeline.current])
  const [activeTimelineId, setActiveTimelineId] = useState(firstTimeline.current.id)
  const [selected, setSelected] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [marks, setMarks] = useState({ in: null, out: null })
  const [dragIndex, setDragIndex] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const exportBatchRef = useRef({ index: 0, total: 1 })
  const progressHistoryRef = useRef([])
  const [toast, setToast] = useState('')
  const [previewStatus, setPreviewStatus] = useState({ state: 'idle', message: '' })
  const [audioZoom, setAudioZoom] = useState(100)
  const [maximized, setMaximized] = useState(false)
  const [images, setImages] = useState([])
  const [selectedImageId, setSelectedImageId] = useState(null)
  const [selectedImageIds, setSelectedImageIds] = useState([])
  const [workspaceMode, setWorkspaceMode] = useState('media')
  const [imageCropEditing, setImageCropEditing] = useState(false)
  const [imageCropRatio, setImageCropRatio] = useState('free')
  const [imageCropDraft, setImageCropDraft] = useState({ x: 0, y: 0, width: 1, height: 1 })
  const [settings, setSettings] = useState({
    ratio: '16:9', ratioMode: 'crop', resolution: '1080p', fps: 30,
    bitrate: 6000, videoFormat: 'mp4', audioFormat: 'mp3', audioBitrate: 192,
    outputDir: '', saveMode: 'ask', namingMode: 'timeline', videoExportUnit: 'timeline', audioExportUnit: 'timeline', normalizeAudio: false,
    loudnessTarget: -16, masterGainDb: 0, transformScope: 'selected', lutScope: 'selected',
    imageFormat: 'jpg', imageWidth: 0, imageHeight: 0, imageLockRatio: true,
    imageResolutionPreset: 'original', imageTargetSizeMb: 0, imageTransformScope: 'selected',
    globalLut: { preset: 'none', path: '', name: '无' }
  })

  const activeTimeline = timelines.find(item => item.id === activeTimelineId) || timelines[0]
  const clips = activeTimeline?.clips || []
  const current = clips.find(clip => clip.id === selected) || null
  const imageMode = workspaceMode === 'image' && images.length > 0
  const imageCurrent = images.find(image => image.id === selectedImageId) || images[0] || null

  const show = message => {
    setToast(message)
    window.clearTimeout(show.timeout)
    show.timeout = window.setTimeout(() => setToast(''), 4200)
  }

  const controller = useMediaTimeController({ clip: current, marks, setTime, setPlaying, setPreviewStatus, show })
  const marksRef = useRef(marks)
  marksRef.current = marks
  const seek = (value, options) => controller.seekTo(value, options)
  const pauseForSeek = controller.beginScrub
  const toggle = controller.toggle

  const setClips = update => {
    if (!activeTimeline) return
    setTimelines(old => old.map(timeline => timeline.id === activeTimeline.id
      ? { ...timeline, clips: typeof update === 'function' ? update(timeline.clips) : update }
      : timeline))
  }

  const resetPreview = () => {
    controller.clearMedia()
    setPlaying(false)
    setSelected(null)
    setTime(0)
    setMarks({ in: null, out: null })
  }

  useEffect(() => api.onProgress(value => {
    const batch = exportBatchRef.current
    const overall = Math.min(100, Math.round((batch.index + value / 100) / Math.max(1, batch.total) * 100))
    if (progressHistoryRef.current.at(-1) !== overall) progressHistoryRef.current.push(overall)
    setProgress(overall)
  }), [])

  useEffect(() => api.onProbed(result => {
    if (!result?.path) return
    if (result.error) {
      setTimelines(old => old.map(timeline => ({
        ...timeline,
        clips: timeline.clips.map(clip => clip.path === result.path && clip.pendingProbe
          ? { ...clip, pendingProbe: false, probeError: result.error }
          : clip)
      })))
      show(`素材分析失败：${result.error}`)
      return
    }
    if (!result.info) return
    setTimelines(old => old.map(timeline => ({
      ...timeline,
      clips: timeline.clips.map(clip => clip.path === result.path && clip.pendingProbe
        ? {
            ...clip, ...result.info, pendingProbe: false, probeError: null,
            start: 0, end: result.info.duration || 0,
            previewPath: result.info.previewPath || clip.path
          }
        : clip)
    })))
  }), [])

  useEffect(() => api.onProxyReady(result => {
    if (!result?.path) return
    if (result.error) {
      setTimelines(old => old.map(timeline => ({ ...timeline, clips: timeline.clips.map(clip => clip.path === result.path ? { ...clip, proxyPending: false, proxyError: result.error } : clip) })))
      return
    }
    setTimelines(old => old.map(timeline => ({
      ...timeline,
      clips: timeline.clips.map(clip => clip.path === result.path
        ? { ...clip, previewPath: result.previewPath, proxied: true, proxyPending: false, proxyError: null }
        : clip)
    })))
  }), [])

  useEffect(() => {
    const change = event => setTimelines(old => old.map(timeline => ({
      ...timeline,
      clips: timeline.clips.map(clip => clip.id === event.detail.id
        ? { ...clip, transition: { ...clip.transition, ...event.detail.patch } }
        : clip)
    })))
    window.addEventListener('cutflow-transition', change)
    return () => window.removeEventListener('cutflow-transition', change)
  }, [])

  useEffect(() => {
    controller.pause()
    if (!current) {
      controller.clearMedia()
      return
    }
    if (current.pendingProbe) {
      controller.clearMedia()
      setMarks({ in: null, out: null })
      setPreviewStatus({ state: 'loading', message: `正在分析素材：${current.name}` })
      return
    }
    if (current.probeError) {
      controller.clearMedia()
      setPreviewStatus({ state: 'error', message: `素材分析失败：${current.probeError}` })
      return
    }
    if (current.proxyPending) {
      controller.clearMedia()
      const nextMarks = { in: current.start, out: current.end }
      marksRef.current = nextMarks
      setMarks(nextMarks)
      setPreviewStatus({ state: 'loading', message: `正在生成流畅预览代理：${current.name}` })
      return
    }
    if (current.proxyError) {
      controller.clearMedia()
      setPreviewStatus({ state: 'error', message: `预览代理生成失败：${current.proxyError}` })
      return
    }
    const nextMarks = { in: current.start, out: current.end }
    marksRef.current = nextMarks
    setMarks(nextMarks)
    controller.loadClip(current)
  }, [current?.id, current?.previewPath, current?.pendingProbe, current?.probeError, current?.proxyPending, current?.proxyError, current?.duration])

  useEffect(() => {
    const key = event => {
      if (!current || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable) return
      const locatedTime = controller.getTime()
      if (event.key.toLowerCase() === 'i') {
        const next = { ...marksRef.current, in: locatedTime }
        marksRef.current = next
        setMarks(next)
        controller.seekTo(locatedTime, { commit: true, immediate: true })
        event.preventDefault()
      }
      if (event.key.toLowerCase() === 'o') {
        const next = { ...marksRef.current, out: locatedTime }
        marksRef.current = next
        setMarks(next)
        controller.seekTo(locatedTime, { commit: true, immediate: true })
        event.preventDefault()
      }
      if (event.code === 'Space') {
        toggle()
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [current?.id])

  const analyzeClip = clip => {
    if (!clip || clip.pendingProbe || clip.probeError || clip.proxyPending || clip.proxyError || clip.visual || clip.visualLoading) return
    setTimelines(old => old.map(timeline => ({
      ...timeline,
      clips: timeline.clips.map(item => item.id === clip.id ? { ...item, visualLoading: true, visualError: null } : item)
    })))
    const job = clip.mediaType === 'video'
      ? api.getThumbnail(clip.previewPath || clip.path, Math.max(0.05, clip.start || 0)).then(result => {
        if (!result.ok || !result.dataUrl) throw new Error(result.error || '首帧提取失败')
        return result.dataUrl
      })
      : api.getWaveform(clip.path, 1800).then(result => {
        if (!result.ok || !result.peaks?.length) throw new Error(result.error || '波形分析失败')
        return result.peaks
      })
    job.then(visual => {
      if (!visual) return
      setTimelines(old => old.map(timeline => ({
        ...timeline,
        clips: timeline.clips.map(item => item.id === clip.id ? { ...item, visual, visualLoading: false, visualError: null } : item)
      })))
    }).catch(error => {
      setTimelines(old => old.map(timeline => ({ ...timeline, clips: timeline.clips.map(item => item.id === clip.id ? { ...item, visualLoading: false, visualError: error.message } : item) })))
      show(`媒体分析失败：${error.message}`)
    })
  }

  useEffect(() => {
    if (!current || current.pendingProbe || current.probeError || current.proxyPending || current.proxyError || current.visual || current.visualLoading || current.visualError) return
    analyzeClip(current)
  }, [current?.id, current?.pendingProbe, current?.probeError, current?.proxyPending, current?.proxyError, current?.previewPath, current?.visual, current?.visualLoading, current?.visualError])

  const addPaths = (paths, targetTimelineId = activeTimeline?.id) => {
    const unique = [...new Set(paths.filter(Boolean))]
    const mediaPaths = unique.filter(path => VIDEO_EXT.test(path) || AUDIO_EXT.test(path))
    if (!mediaPaths.length || !targetTimelineId) return
    const placeholders = mediaPaths.map(path => ({
      id: crypto.randomUUID(), path, previewPath: path, name: fileName(path),
      mediaType: VIDEO_EXT.test(path) ? 'video' : 'audio',
      hasAudio: AUDIO_EXT.test(path) ? true : null,
      width: 0, height: 0, duration: 0, start: 0, end: 0,
      visual: null, visualLoading: false, proxied: false, proxyPending: false,
      pendingProbe: true, probeError: null, gainDb: 0,
      lut: { preset: 'none', path: '', name: '无' },
      transition: { type: 'none', duration: 0.5 },
      transform: { scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }
    }))
    setTimelines(old => old.map(timeline => timeline.id === targetTimelineId
      ? { ...timeline, clips: [...timeline.clips, ...placeholders] }
      : timeline))
    setActiveTimelineId(targetTimelineId)
    setSelected(placeholders.at(-1).id)
    setWorkspaceMode('media')
    placeholders.forEach(clip => {
      api.prepareMedia(clip.path).then(result => {
        if (result?.ok) return
        const message = result?.error || '无法准备素材'
        setTimelines(old => old.map(timeline => ({
          ...timeline,
          clips: timeline.clips.map(item => item.id === clip.id ? { ...item, pendingProbe: false, probeError: message } : item)
        })))
        show(`无法导入 ${clip.name}：${message}`)
      }).catch(error => {
        setTimelines(old => old.map(timeline => ({
          ...timeline,
          clips: timeline.clips.map(item => item.id === clip.id ? { ...item, pendingProbe: false, probeError: error.message } : item)
        })))
        show(`无法导入 ${clip.name}：${error.message}`)
      })
    })
    show(`已添加 ${placeholders.length} 个素材，正在后台分析…`)
  }

  const addImages = paths => {
    const imagePaths = [...new Set(paths.filter(path => path && IMAGE_EXT.test(path)))]
    if (!imagePaths.length) return
    const added = imagePaths.map(path => ({
      id: crypto.randomUUID(), path, name: fileName(path), width: 0, height: 0,
      loaded: false, error: null,
      transform: { scale: 100, rotation: 0 }, crop: null
    }))
    setImages(old => [...old, ...added])
    setSelectedImageId(added.at(-1).id)
    setSelectedImageIds([added.at(-1).id])
    setWorkspaceMode('image')
    setImageCropEditing(false)
    controller.pause()
    setPlaying(false)
    setPreviewStatus({ state: 'ready', message: '' })
    show(`已添加 ${imagePaths.length} 张图片`)
  }

  const requestImport = (paths, targetTimelineId = activeTimeline?.id) => {
    const clean = paths.filter(Boolean)
    const mediaPaths = clean.filter(path => VIDEO_EXT.test(path) || AUDIO_EXT.test(path))
    const imagePaths = clean.filter(path => IMAGE_EXT.test(path))
    if (mediaPaths.length) addPaths(mediaPaths, targetTimelineId)
    if (imagePaths.length) addImages(imagePaths)
  }

  const updateImage = (id, patch) => setImages(old => old.map(image => image.id === id ? { ...image, ...patch } : image))
  const updateImageTransform = patch => {
    if (!imageCurrent) return
    if (settings.imageTransformScope === 'all') {
      setImages(old => old.map(image => ({ ...image, transform: { ...image.transform, ...patch } })))
    } else {
      const targets = new Set(selectedImageIds.length ? selectedImageIds : [imageCurrent.id])
      setImages(old => old.map(image => targets.has(image.id) ? { ...image, transform: { ...image.transform, ...patch } } : image))
    }
  }
  const resetImageTransform = () => updateImageTransform({ scale: 100, rotation: 0 })
  const cropForRatio = ratio => {
    if (!imageCurrent || ratio === 'free') return imageCurrent?.crop || { x: 0, y: 0, width: 1, height: 1 }
    const rotation = imageCurrent.transform?.rotation || 0
    const radians = rotation * Math.PI / 180
    const sourceWidth = Math.abs(imageCurrent.width * Math.cos(radians)) + Math.abs(imageCurrent.height * Math.sin(radians))
    const sourceHeight = Math.abs(imageCurrent.width * Math.sin(radians)) + Math.abs(imageCurrent.height * Math.cos(radians))
    const sourceRatio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 1
    const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
    const targetRatio = ratioWidth / ratioHeight
    if (sourceRatio > targetRatio) {
      const width = targetRatio / sourceRatio
      return { x: (1 - width) / 2, y: 0, width, height: 1 }
    }
    const height = sourceRatio / targetRatio
    return { x: 0, y: (1 - height) / 2, width: 1, height }
  }
  const beginImageCrop = ratio => {
    setImageCropRatio(ratio)
    setImageCropDraft(cropForRatio(ratio))
    setImageCropEditing(true)
  }
  const applyImageCrop = () => {
    const crop = { ...imageCropDraft }
    if (settings.imageTransformScope === 'all') setImages(old => old.map(image => ({ ...image, crop })))
    else if (imageCurrent) {
      const targets = new Set(selectedImageIds.length ? selectedImageIds : [imageCurrent.id])
      setImages(old => old.map(image => targets.has(image.id) ? { ...image, crop } : image))
    }
    setImageCropEditing(false)
    show(settings.imageTransformScope === 'all' ? '裁切已应用到全部图片' : '裁切已应用到选中图片')
  }
  const removeImage = id => {
    const index = images.findIndex(image => image.id === id)
    const remaining = images.filter(image => image.id !== id)
    setImages(remaining)
    if (!remaining.length) {
      setSelectedImageId(null)
      setSelectedImageIds([])
      setWorkspaceMode('media')
      setImageCropEditing(false)
      setPreviewStatus(current ? { state: 'ready', message: '' } : { state: 'idle', message: '' })
      return
    }
    const nextSelectedIds = selectedImageIds.filter(imageId => imageId !== id)
    if (selectedImageId === id) {
      const nextPrimary = nextSelectedIds.at(-1) || remaining[Math.min(index, remaining.length - 1)].id
      setSelectedImageId(nextPrimary)
      setSelectedImageIds(nextSelectedIds.length ? nextSelectedIds : [nextPrimary])
    } else setSelectedImageIds(nextSelectedIds)
  }
  const clearImages = () => {
    setImages([])
    setSelectedImageId(null)
    setSelectedImageIds([])
    setWorkspaceMode('media')
    setImageCropEditing(false)
    setPreviewStatus(current ? { state: 'ready', message: '' } : { state: 'idle', message: '' })
  }
  const selectImages = (ids, primaryId) => {
    const valid = [...new Set(ids)].filter(id => images.some(image => image.id === id))
    const primary = primaryId && valid.includes(primaryId) ? primaryId : valid.at(-1)
    setSelectedImageIds(valid)
    setSelectedImageId(primary || null)
    setImageCropEditing(false)
  }

  const updateCurrent = patch => setClips(old => old.map(clip => clip.id === selected ? { ...clip, ...patch } : clip))
  const updateTransform = patch => current && updateCurrent({ transform: { ...current.transform, ...patch } })
  const resetTransform = () => updateTransform({ scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 })
  const updateTransformScoped = patch => {
    if (!current || current.mediaType !== 'video') return
    if (settings.transformScope === 'all') {
      setTimelines(old => old.map(timeline => ({
        ...timeline,
        clips: timeline.clips.map(clip => clip.mediaType === 'video' ? { ...clip, transform: { ...clip.transform, ...patch } } : clip)
      })))
    } else updateTransform(patch)
  }
  const resetTransformScoped = () => updateTransformScoped({ scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 })
  const applyLut = lut => {
    if (!current || current.mediaType !== 'video') return
    if (settings.lutScope === 'all') {
      setTimelines(old => old.map(timeline => ({
        ...timeline,
        clips: timeline.clips.map(clip => clip.mediaType === 'video' ? { ...clip, lut } : clip)
      })))
    } else updateCurrent({ lut })
  }

  const split = () => {
    const locatedTime = controller.getTime()
    if (!current || locatedTime <= current.start + 0.05 || locatedTime >= current.end - 0.05) return
    const second = {
      ...current, id: crypto.randomUUID(), start: locatedTime,
      name: `${current.name.replace(/ · 片段 \d+$/, '')} · 片段`,
      visual: null, visualLoading: false, visualError: null
    }
    setClips(old => old.flatMap(clip => clip.id === current.id ? [{ ...clip, end: locatedTime }, second] : clip))
    setSelected(second.id)
  }

  const applyMarks = () => {
    const entry = marksRef.current.in
    const exit = marksRef.current.out
    if (entry == null || exit == null || exit - entry < 0.1) return show('出点必须晚于入点')
    setClips(old => old.map(clip => clip.id === selected
      ? { ...clip, start: entry, end: exit, visual: null, visualLoading: false, visualError: null }
      : clip))
    controller.seekTo(entry, { commit: true, immediate: true })
    show('已按入出点裁切')
  }

  const setMarkAt = (kind, value) => {
    const next = { ...marksRef.current, [kind]: value }
    marksRef.current = next
    setMarks(next)
    controller.seekTo(value, { commit: true, immediate: true })
  }

  const removeClip = (timelineId, clipId) => {
    const lane = timelines.find(timeline => timeline.id === timelineId)
    const remaining = lane?.clips.filter(clip => clip.id !== clipId) || []
    setTimelines(old => old.map(timeline => timeline.id === timelineId
      ? { ...timeline, clips: timeline.clips.filter(clip => clip.id !== clipId) }
      : timeline))
    if (selected === clipId) {
      if (remaining.length) setSelected(remaining[0].id)
      else resetPreview()
    }
  }

  const reorder = (timelineId, targetIndex) => {
    if (!dragIndex || (dragIndex.timelineId === timelineId && dragIndex.index === targetIndex)) return
    const movedId = timelines.find(timeline => timeline.id === dragIndex.timelineId)?.clips[dragIndex.index]?.id
    const action = () => setTimelines(old => {
      const source = old.find(timeline => timeline.id === dragIndex.timelineId)
      const moved = source?.clips[dragIndex.index]
      if (!moved) return old
      return old.map(timeline => {
        const next = [...timeline.clips]
        if (timeline.id === dragIndex.timelineId) next.splice(dragIndex.index, 1)
        if (timeline.id === timelineId) next.splice(Math.min(targetIndex, next.length), 0, moved)
        return { ...timeline, clips: next }
      })
    })
    document.startViewTransition ? document.startViewTransition(action) : action()
    setDragIndex({ timelineId, index: targetIndex })
    if (dragIndex.timelineId !== timelineId) {
      setActiveTimelineId(timelineId)
      if (movedId) setSelected(movedId)
    }
  }

  const switchTimeline = id => {
    const target = timelines.find(timeline => timeline.id === id)
    setActiveTimelineId(id)
    setSelected(target?.clips[0]?.id || null)
    if (!target?.clips.length) resetPreview()
  }

  const newTimeline = () => {
    const item = { id: crypto.randomUUID(), name: `时间轴 ${timelines.length + 1}`, clips: [] }
    setTimelines(old => [...old, item])
    setActiveTimelineId(item.id)
    resetPreview()
  }

  const newTimelineFromDrop = event => {
    event.preventDefault()
    event.stopPropagation()
    const item = { id: crypto.randomUUID(), name: `时间轴 ${timelines.length + 1}`, clips: [] }
    const paths = [...event.dataTransfer.files].map(api.filePath).filter(Boolean)
    setTimelines(old => [...old, item])
    setActiveTimelineId(item.id)
    resetPreview()
    addPaths(paths, item.id)
  }

  const closeTimeline = id => {
    const target = timelines.find(timeline => timeline.id === id)
    if (timelines.length === 1) {
      setTimelines([{ ...target, clips: [] }])
      resetPreview()
      return
    }
    const index = timelines.findIndex(timeline => timeline.id === id)
    const next = timelines[index > 0 ? index - 1 : 1]
    setTimelines(old => old.filter(timeline => timeline.id !== id))
    if (activeTimeline?.id === id) {
      setActiveTimelineId(next.id)
      setSelected(next.clips[0]?.id || null)
      if (!next.clips.length) resetPreview()
    }
  }

  const renameTimeline = (id, name) => setTimelines(old => old.map(timeline => timeline.id === id ? { ...timeline, name } : timeline))

  const doExport = async mode => {
    const jobs = buildExportJobs(timelines, mode, settings)
    if (!jobs.length) return show(mode === 'video' ? '没有可导出的视频片段' : '没有可导出的声音片段')
    const extension = mode === 'video' ? (settings.videoFormat === 'mp4' ? 'mp4' : 'mov') : settings.audioFormat
    let directory = settings.saveMode === 'folder' ? settings.outputDir : ''
    if (jobs.length > 1 && !directory) directory = await api.chooseOutputDir()
    if (jobs.length > 1 && !directory) return
    setExporting(true)
    setProgress(0)
    progressHistoryRef.current = [0]
    exportBatchRef.current = { index: 0, total: jobs.length }
    for (let index = 0; index < jobs.length; index += 1) {
      exportBatchRef.current = { index, total: jobs.length }
      const job = jobs[index]
      const output = directory
        ? `${directory}${directory.includes('\\') ? '\\' : '/'}${job.name}.${extension}`
        : await api.chooseOutput(mode, mode === 'video' ? settings.videoFormat : settings.audioFormat, job.name)
      if (!output) continue
      const result = await api.exportMedia({ clips: job.clips, output, mode, settings })
      if (!result.ok) {
        setExporting(false)
        return show(result.error || '导出失败')
      }
      setProgress(Math.round((index + 1) / jobs.length * 100))
    }
    setExporting(false)
    setProgress(100)
    show(`已导出 ${jobs.length} 个${(mode === 'video' ? settings.videoExportUnit : settings.audioExportUnit) === 'clip' ? '片段' : '时间轴'}`)
  }

  const doImageExport = async () => {
    if (!images.length) return show('没有可导出的图片')
    const format = settings.imageFormat || 'jpg'
    let directory = settings.saveMode === 'folder' ? settings.outputDir : ''
    if (!directory && images.length > 1) directory = await api.chooseOutputDir()
    if (!directory && images.length > 1) return
    let items = buildImageExportItems(images, directory, format)
    if (!directory) {
      const output = await api.chooseOutput('image', format, items[0].name)
      if (!output) return
      items = [{ ...items[0], output }]
    }
    setExporting(true)
    setProgress(0)
    progressHistoryRef.current = [0]
    exportBatchRef.current = { index: 0, total: 1 }
    const result = await api.exportImages({ images: items, settings })
    setExporting(false)
    if (!result?.ok) return show(result?.error || '图片导出失败')
    setProgress(100)
    show(`已按原文件名导出 ${items.length} 张图片`)
  }

  const rootDrop = event => {
    event.preventDefault()
    requestImport([...event.dataTransfer.files].map(api.filePath).filter(Boolean))
  }

  // Development-only bridge for the Electron smoke test. It exercises the
  // same import, time controller, transform and export paths as the visible UI.
  if (new URLSearchParams(window.location.search).get('smoke') === '1') {
    window.__cutflowTest = {
      importPaths: paths => requestImport(paths),
      importImages: paths => addImages(paths),
      selectClip: (clipId, timelineId = activeTimeline?.id) => {
        setActiveTimelineId(timelineId)
        setSelected(clipId)
      },
      scrubTo: value => {
        controller.beginScrub()
        controller.seekTo(value, { immediate: true })
        return controller.endScrub()
      },
      markAt: (kind, value) => setMarkAt(kind, value),
      trim: applyMarks,
      split,
      removeSelected: () => current && removeClip(activeTimeline.id, current.id),
      transform: patch => updateTransform(patch),
      setClipLut: (clipId, lut) => setTimelines(old => old.map(timeline => ({ ...timeline, clips: timeline.clips.map(clip => clip.id === clipId ? { ...clip, lut } : clip) }))),
      outputName: (timelineId, namingMode) => outputBaseName(timelines.find(timeline => timeline.id === timelineId), namingMode),
      exportJobs: (mode, unit) => buildExportJobs(timelines, mode, {
        ...settings,
        [mode === 'video' ? 'videoExportUnit' : 'audioExportUnit']: unit
      }).map(job => ({ name: job.name, clipCount: job.clips.length })),
      toggle: controller.toggle,
      playFromIn: () => controller.playFromIn(marksRef.current),
      pause: controller.pause,
      clearProgressHistory: () => { progressHistoryRef.current = [] },
      exportActive: (output, mode, overrides = {}) => api.exportMedia({
        clips: activeTimeline?.clips || [], output, mode,
        settings: { ...settings, ...overrides }
      }),
      exportClip: (clipId, output, overrides = {}) => api.exportMedia({
        clips: (activeTimeline?.clips || []).filter(clip => clip.id === clipId), output, mode: 'video',
        settings: { ...settings, ...overrides }
      }),
      imageJobs: (directory, format = settings.imageFormat) => buildImageExportItems(images, directory, format).map(item => ({ name: item.name, output: item.output })),
      clipWidth: duration => timelineClipWidth(duration),
      setImageTransform: patch => updateImageTransform(patch),
      setImageSettings: patch => setSettings(old => ({ ...old, ...patch })),
      beginImageCrop,
      exportImageBatch: (directory, overrides = {}) => {
        const nextSettings = { ...settings, ...overrides }
        return api.exportImages({ images: buildImageExportItems(images, directory, nextSettings.imageFormat), settings: nextSettings })
      },
      state: () => {
        const video = controller.videoRef.current
        const audio = controller.audioRef.current
        return {
          selected, playing, time: controller.getTime(), marks: controller.getMarks(), audioZoom,
          workspaceMode, selectedImageId, selectedImageIds: [...selectedImageIds],
          images: images.map(image => ({ ...image })),
          settings: {
            ratio: settings.ratio, bitrate: settings.bitrate, videoFormat: settings.videoFormat,
            videoExportUnit: settings.videoExportUnit, audioExportUnit: settings.audioExportUnit,
            imageFormat: settings.imageFormat, imageWidth: settings.imageWidth, imageHeight: settings.imageHeight,
            imageResolutionPreset: settings.imageResolutionPreset, imageTargetSizeMb: settings.imageTargetSizeMb,
            imageTransformScope: settings.imageTransformScope
          },
          imageCropEditing, imageCropRatio, imageCropDraft,
          lutPreview: document.querySelector('.lut-preview-canvas.active')?.dataset.lutPreset || null,
          lutPreviewError: document.querySelector('.lut-preview-canvas')?.dataset.lutError || null,
          progress, progressHistory: [...progressHistoryRef.current],
          previewStatus, activeTimelineId,
          timelines: timelines.map(timeline => ({
            id: timeline.id, name: timeline.name,
            clips: timeline.clips.map(item => ({
              id: item.id, name: item.name, path: item.path, previewPath: item.previewPath,
              mediaType: item.mediaType, start: item.start, end: item.end,
              duration: item.duration, proxied: item.proxied, pendingProbe: Boolean(item.pendingProbe),
              visualReady: item.mediaType === 'video' ? /^data:image\/jpeg/.test(item.visual || '') : Boolean(item.visual?.length),
              visualPoints: Array.isArray(item.visual) ? item.visual.length : 0,
              visualTail: typeof item.visual === 'string' ? item.visual.slice(-48) : '',
              visualLoading: Boolean(item.visualLoading), visualError: item.visualError || null,
              probeError: item.probeError || null, transform: item.transform, lut: item.lut
            }))
          })),
          video: {
            mountId: video?.dataset.mountId, clipId: video?.dataset.clipId,
            src: video?.dataset.mediaSource || '', currentTime: video?.currentTime || 0,
            readyState: video?.readyState || 0, width: video?.videoWidth || 0,
            height: video?.videoHeight || 0, paused: video?.paused ?? true,
            seeking: video?.seeking ?? false, networkState: video?.networkState ?? 0
          },
          audio: {
            mountId: audio?.dataset.mountId, clipId: audio?.dataset.clipId,
            src: audio?.dataset.mediaSource || '', currentTime: audio?.currentTime || 0,
            readyState: audio?.readyState || 0, paused: audio?.paused ?? true,
            seeking: audio?.seeking ?? false, networkState: audio?.networkState ?? 0
          },
          metrics: { ...controller.metrics.current }
        }
      }
    }
  }

  return <div className="app" onDragOver={event => event.preventDefault()} onDrop={rootDrop}>
    <header>
      <div className="brand"><div className="logo"><Scissors size={20}/></div><span>剪影工坊 v1.53</span></div>
      <div className="window-controls">
        <button onClick={api.windowMinimize}><Minus/></button>
        <button onClick={async () => setMaximized(await api.windowMaximize())}>{maximized ? <Minimize2/> : <Maximize2/>}</button>
        <button className="close" onClick={api.windowClose}><X/></button>
      </div>
    </header>
    <main>
      <section className={`workspace ${imageMode ? 'image-workspace' : ''}`}>
        <div className={`viewer ${current?.mediaType === 'audio' && !imageMode ? 'audio-viewer' : ''} ${imageMode ? 'image-viewer' : ''}`}>
          {imageMode
            ? <ImagePreview
                image={imageCurrent} updateImage={patch => updateImage(imageCurrent.id, patch)}
                cropEditing={imageCropEditing} cropRatio={imageCropRatio}
                cropDraft={imageCropDraft} setCropDraft={setImageCropDraft}
                onApplyCrop={applyImageCrop} onCancelCrop={() => setImageCropEditing(false)}
              />
            : <MediaPreview
                clip={current} hidden={!current} controller={controller}
                marks={marks} ratio={settings.ratio} ratioMode={settings.ratioMode}
                audioZoom={audioZoom} setAudioZoom={setAudioZoom} updateTransform={updateTransform}
              />}
          {!imageMode && current && previewStatus.state !== 'ready' && previewStatus.state !== 'idle' && <div className={`preview-status ${previewStatus.state}`}><span className="preview-status-dot"/><b>{previewStatus.message}</b></div>}
          {imageMode && imageCurrent
            ? <div className="viewer-title">{imageCurrent.name}<span>图片 · {imageCurrent.width || '—'} × {imageCurrent.height || '—'}</span></div>
            : current
            ? <div className="viewer-title">{current.name}<span>{current.mediaType === 'audio' ? '音频' : '视频'} · {fmt(current.end - current.start)}</span></div>
            : <div className="empty" onClick={() => api.openMedia().then(paths => requestImport(paths))}>
                <div className="drop-icon"><Upload/></div>
                <h2>拖入视频、音频或图片</h2>
                <button><FolderOpen/>选择文件</button>
              </div>}
        </div>

        {!imageMode && <>
          <div className="controls">
            <button disabled={!current || current.pendingProbe || current.proxyPending || Boolean(current.probeError) || Boolean(current.proxyError)} onClick={playing ? controller.pause : () => controller.playFromIn(marksRef.current)}>{playing ? <Pause/> : <Play/>}</button>
            <TimeReadout controller={controller} fallback={time}/>
            <PrecisionScrubber clip={current} time={time} marks={marks} setMarks={setMarks} controller={controller}/>
            <span>{fmt(current?.end || 0)}</span>
          </div>
          <div className="editbar">
            <button onClick={() => setMarkAt('in', controller.getTime())} disabled={!current}><LogIn/>设为入点 <kbd>I</kbd></button>
            <button onClick={() => setMarkAt('out', controller.getTime())} disabled={!current}><LogOut/>设为出点 <kbd>O</kbd></button>
            <button className="trim-action" onClick={applyMarks} disabled={!current}><Scissors/>按入出点裁切</button>
            <button className="split-action" onClick={split} disabled={!current}><Scissors/>按播放头位置分割</button>
            {current && <div className="inline-time">
              <label>入 <input type="number" step="0.1" value={(marks.in ?? current.start).toFixed(1)} onChange={event => setMarkAt('in', +event.target.value)}/></label>
              <label>出 <input type="number" step="0.1" value={(marks.out ?? current.end).toFixed(1)} onChange={event => setMarkAt('out', +event.target.value)}/></label>
            </div>}
          </div>
        </>}

        {imageMode ? <ImageFolder
          images={images} selectedId={selectedImageId} selectedIds={selectedImageIds}
          onSelectionChange={selectImages} onRemove={removeImage} onClear={clearImages}
          onMeta={(id, patch) => updateImage(id, patch)}
          onAdd={() => api.openImages().then(addImages)} onDrop={paths => addImages(paths)}
        /> : <>
            <div className="timeline-stack">
              {timelines.map(timeline => {
                const laneTotal = timeline.clips.reduce((sum, clip) => sum + clip.end - clip.start, 0)
                return <section key={timeline.id} className={`timeline-lane ${timeline.id === activeTimeline?.id ? 'active' : ''}`} onClick={() => switchTimeline(timeline.id)}>
                  <div className="timeline-head">
                    <div>
                      <div className="timeline-name-row">
                        <input className="timeline-name-input" value={timeline.name} onClick={event => event.stopPropagation()} onChange={event => renameTimeline(timeline.id, event.target.value)} onBlur={event => !event.target.value.trim() && renameTimeline(timeline.id, `时间轴 ${timelines.indexOf(timeline) + 1}`)}/>
                        <span>· {timelineKind(timeline.clips)}</span>
                      </div>
                      <small>{timeline.clips.length} 个片段 · {fmt(laneTotal)}</small>
                    </div>
                    <button className="close-timeline" onClick={event => { event.stopPropagation(); closeTimeline(timeline.id) }}><X/>{timelines.length === 1 ? '清空' : '关闭'}</button>
                  </div>
                  <div className="timeline">
                    {timeline.clips.map((clip, index) => <TimelineClip
                      key={clip.id} clip={clip}
                      active={selected === clip.id && timeline.id === activeTimeline?.id}
                      dragging={dragIndex?.timelineId === timeline.id && dragIndex.index === index}
                      onSelect={() => { setActiveTimelineId(timeline.id); setSelected(clip.id) }}
                      onRemove={() => removeClip(timeline.id, clip.id)}
                      onDragStart={() => setDragIndex({ timelineId: timeline.id, index })}
                      onDragEnter={() => reorder(timeline.id, index)}
                      onDragEnd={() => setDragIndex(null)}
                      onVisible={() => analyzeClip(clip)}
                      onRetry={() => {
                        if (!clip.probeError && !clip.proxyError) return analyzeClip(clip)
                        setTimelines(old => old.map(item => ({ ...item, clips: item.clips.map(candidate => candidate.id === clip.id ? { ...candidate, pendingProbe: true, probeError: null, proxyError: null } : candidate) })))
                        api.prepareMedia(clip.path).then(result => {
                          if (!result?.ok) throw new Error(result?.error || '无法准备素材')
                        }).catch(error => {
                          setTimelines(old => old.map(item => ({ ...item, clips: item.clips.map(candidate => candidate.id === clip.id ? { ...candidate, pendingProbe: false, probeError: error.message } : candidate) })))
                          show(`素材分析失败：${error.message}`)
                        })
                      }}
                    />)}
                    <button className="add-card" onClick={event => { event.stopPropagation(); api.openMedia().then(paths => addPaths(paths, timeline.id)) }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); addPaths([...event.dataTransfer.files].map(api.filePath), timeline.id) }}>
                      <Plus/>{timeline.clips.length ? '添加' : '拖入或选择文件'}
                    </button>
                  </div>
                </section>
              })}
            </div>
            <button className="new-timeline-drop" onClick={newTimeline} onDragOver={event => event.preventDefault()} onDrop={newTimelineFromDrop}><Plus/>新建时间轴 · 可拖入文件新建</button>
          </>}
      </section>
      <ExportPanelV2
        settings={settings} setSettings={setSettings} current={current}
        updateCurrent={updateCurrent} updateTransform={updateTransformScoped} resetTransform={resetTransformScoped} applyLut={applyLut}
        timelines={timelines} exporting={exporting} progress={progress} doExport={doExport}
        imageMode={imageMode} imageCurrent={imageCurrent} updateImageTransform={updateImageTransform}
        resetImageTransform={resetImageTransform} doImageExport={doImageExport}
        beginImageCrop={beginImageCrop} imageCropEditing={imageCropEditing} imageCropRatio={imageCropRatio}
      />
    </main>
    {toast && <div className="toast"><CheckCircle2/>{toast}</div>}
  </div>
}

function TimeReadout({ controller, fallback }) {
  const ref = useRef(null)
  useEffect(() => controller.subscribe(value => { if (ref.current) ref.current.textContent = fmt(value) }), [controller])
  return <span ref={ref}>{fmt(fallback)}</span>
}

function ImagePreview({ image, updateImage, cropEditing, cropRatio, cropDraft, setCropDraft, onApplyCrop, onCancelCrop }) {
  const frame = useRef(null)
  const drag = useRef(null)
  const [view, setView] = useState({ zoom: 100, x: 0, y: 0 })
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 })
  useEffect(() => setView({ zoom: 100, x: 0, y: 0 }), [image?.id])
  useEffect(() => { if (cropEditing) setView({ zoom: 100, x: 0, y: 0 }) }, [cropEditing])
  useLayoutEffect(() => {
    if (!frame.current) return
    const update = () => setFrameSize({ width: frame.current.clientWidth || 1, height: frame.current.clientHeight || 1 })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [image?.id])
  if (!image) return null
  const transform = image.transform || { scale: 100, rotation: 0 }
  const down = event => {
    if (cropEditing || event.button !== 0) return
    event.preventDefault()
    drag.current = { x: event.clientX, y: event.clientY, startX: view.x, startY: view.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('is-panning')
  }
  const move = event => {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    setView(old => ({ ...old, x: drag.current.startX + event.clientX - drag.current.x, y: drag.current.startY + event.clientY - drag.current.y }))
  }
  const up = event => {
    drag.current = null
    event.currentTarget.classList.remove('is-panning')
  }
  const wheel = event => {
    event.preventDefault()
    if (cropEditing) return
    const nextZoom = Math.max(25, Math.min(800, view.zoom + (event.deltaY < 0 ? 25 : -25)))
    setView(old => ({ ...old, zoom: nextZoom }))
  }
  const radians = (transform.rotation || 0) * Math.PI / 180
  const rotatedWidth = Math.abs(image.width * Math.cos(radians)) + Math.abs(image.height * Math.sin(radians))
  const rotatedHeight = Math.abs(image.width * Math.sin(radians)) + Math.abs(image.height * Math.cos(radians))
  const fit = image.width > 0 && image.height > 0 ? Math.min(frameSize.width / rotatedWidth, frameSize.height / rotatedHeight) : 1
  const style = {
    width: image.width > 0 ? `${image.width * fit}px` : '100%',
    height: image.height > 0 ? `${image.height * fit}px` : '100%',
    objectFit: 'fill',
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom / 100}) rotate(${transform.rotation || 0}deg) scale(${cropEditing ? 1 : (transform.scale || 100) / 100})`
  }
  const croppedStyle = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom / 100}) scale(${(transform.scale || 100) / 100})` }
  return <div ref={frame} className={`image-preview-frame ${cropEditing ? 'crop-editing' : ''}`} onWheel={wheel} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    {image.crop && !cropEditing
      ? <CroppedImageCanvas image={image} className="image-preview-cropped" style={croppedStyle}/>
      : <img
          src={api.mediaUrl(image.path)} draggable="false" style={style}
          onLoad={event => updateImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight, loaded: true, error: null })}
          onError={() => updateImage({ loaded: false, error: '图片预览失败' })}
        />}
    {cropEditing && <ImageCropOverlay image={image} frameSize={frameSize} ratio={cropRatio} draft={cropDraft} setDraft={setCropDraft} onApply={onApplyCrop} onCancel={onCancelCrop}/>}
    {image.error && <div className="image-preview-error">{image.error}</div>}
    {!cropEditing && <div className="image-view-zoom">预览 {view.zoom}% · 滚轮缩放，左键拖动</div>}
  </div>
}

function CroppedImageCanvas({ image, className = '', style }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image.crop) return
    let disposed = false
    const source = new window.Image()
    source.crossOrigin = 'anonymous'
    source.onload = () => {
      if (disposed) return
      const rotation = ((Number(image.transform?.rotation) || 0) % 360 + 360) % 360
      const radians = rotation * Math.PI / 180
      const maxSource = className.includes('thumb') ? 700 : 2200
      const sourceScale = Math.min(1, maxSource / Math.max(source.naturalWidth, source.naturalHeight))
      const width = Math.max(1, Math.round(source.naturalWidth * sourceScale))
      const height = Math.max(1, Math.round(source.naturalHeight * sourceScale))
      const rotatedWidth = Math.max(1, Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))))
      const rotatedHeight = Math.max(1, Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))))
      const rotated = document.createElement('canvas')
      rotated.width = rotatedWidth
      rotated.height = rotatedHeight
      const context = rotated.getContext('2d')
      context.translate(rotatedWidth / 2, rotatedHeight / 2)
      context.rotate(radians)
      context.drawImage(source, -width / 2, -height / 2, width, height)
      const cropX = Math.max(0, Math.min(rotatedWidth - 1, Math.round(image.crop.x * rotatedWidth)))
      const cropY = Math.max(0, Math.min(rotatedHeight - 1, Math.round(image.crop.y * rotatedHeight)))
      const cropWidth = Math.max(1, Math.min(rotatedWidth - cropX, Math.round(image.crop.width * rotatedWidth)))
      const cropHeight = Math.max(1, Math.min(rotatedHeight - cropY, Math.round(image.crop.height * rotatedHeight)))
      canvas.width = cropWidth
      canvas.height = cropHeight
      canvas.getContext('2d').drawImage(rotated, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
      canvas.dataset.cropApplied = 'true'
    }
    source.onerror = () => { if (!disposed) canvas.dataset.cropError = 'true' }
    source.src = api.mediaUrl(image.path)
    return () => { disposed = true; source.src = '' }
  }, [image.path, image.crop?.x, image.crop?.y, image.crop?.width, image.crop?.height, image.transform?.rotation, className])
  return <canvas ref={canvasRef} className={className} style={style}/>
}

function ImageCropOverlay({ image, frameSize, ratio, draft, setDraft, onApply, onCancel }) {
  const drag = useRef(null)
  const rotation = image.transform?.rotation || 0
  const radians = rotation * Math.PI / 180
  const sourceWidth = Math.abs(image.width * Math.cos(radians)) + Math.abs(image.height * Math.sin(radians))
  const sourceHeight = Math.abs(image.width * Math.sin(radians)) + Math.abs(image.height * Math.cos(radians))
  const sourceRatio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 1
  const fit = Math.min(frameSize.width / Math.max(1, sourceWidth), frameSize.height / Math.max(1, sourceHeight))
  const rect = {
    width: Math.max(1, sourceWidth * fit), height: Math.max(1, sourceHeight * fit),
    left: (frameSize.width - sourceWidth * fit) / 2, top: (frameSize.height - sourceHeight * fit) / 2
  }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
  const down = event => {
    const action = event.target.closest('[data-crop-action]')?.dataset.cropAction
    if (!action || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    drag.current = { action, x: event.clientX, y: event.clientY, start: { ...draft } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = event => {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const dx = (event.clientX - drag.current.x) / rect.width
    const dy = (event.clientY - drag.current.y) / rect.height
    const start = drag.current.start
    if (drag.current.action === 'move') {
      setDraft({ ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) })
      return
    }
    const leftHandle = drag.current.action.includes('w')
    const topHandle = drag.current.action.includes('n')
    let width = clamp(start.width + (leftHandle ? -dx : dx), 0.05, leftHandle ? start.x + start.width : 1 - start.x)
    let height = clamp(start.height + (topHandle ? -dy : dy), 0.05, topHandle ? start.y + start.height : 1 - start.y)
    if (ratio !== 'free') {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
      const normalizedHeight = width * sourceRatio / (ratioWidth / ratioHeight)
      const maxHeight = topHandle ? start.y + start.height : 1 - start.y
      if (normalizedHeight <= maxHeight) height = normalizedHeight
      else {
        height = maxHeight
        width = height * (ratioWidth / ratioHeight) / sourceRatio
      }
    }
    const x = leftHandle ? start.x + start.width - width : start.x
    const y = topHandle ? start.y + start.height - height : start.y
    setDraft({ x: clamp(x, 0, 1 - width), y: clamp(y, 0, 1 - height), width, height })
  }
  const up = event => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const selection = {
    left: rect.left + draft.x * rect.width,
    top: rect.top + draft.y * rect.height,
    width: draft.width * rect.width,
    height: draft.height * rect.height
  }
  return <div className="image-crop-overlay" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="image-crop-selection" data-crop-action="move" style={selection}>
      {['nw', 'ne', 'sw', 'se'].map(handle => <i key={handle} className={handle} data-crop-action={handle}/>)}
      <span>{ratio === 'free' ? '自由裁切' : ratio}</span>
    </div>
    <div className="image-crop-actions"><button onClick={event => { event.stopPropagation(); onCancel() }}>取消</button><button className="apply" onClick={event => { event.stopPropagation(); onApply() }}><CheckCircle2/>应用裁切</button></div>
  </div>
}

function ImageFolder({ images, selectedId, selectedIds, onSelectionChange, onRemove, onClear, onMeta, onAdd, onDrop }) {
  const anchorRef = useRef(selectedId)
  const marqueeRef = useRef(null)
  const [marquee, setMarquee] = useState(null)
  const selectedSet = new Set(selectedIds)
  const drop = event => {
    event.preventDefault()
    event.stopPropagation()
    onDrop([...event.dataTransfer.files].map(api.filePath).filter(Boolean))
  }
  const selectCard = (event, id) => {
    const index = images.findIndex(image => image.id === id)
    if (event.shiftKey && anchorRef.current) {
      const anchorIndex = images.findIndex(image => image.id === anchorRef.current)
      if (anchorIndex >= 0) {
        const range = images.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1).map(image => image.id)
        onSelectionChange(event.ctrlKey || event.metaKey ? [...new Set([...selectedIds, ...range])] : range, id)
        return
      }
    }
    anchorRef.current = id
    if (event.ctrlKey || event.metaKey) {
      const next = selectedSet.has(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id]
      onSelectionChange(next, next.includes(id) ? id : next.at(-1))
    } else onSelectionChange([id], id)
  }
  const marqueeDown = event => {
    if (event.button !== 0 || event.target.closest('.image-card,.image-add-card')) return
    const grid = event.currentTarget
    const rect = grid.getBoundingClientRect()
    const base = event.ctrlKey || event.metaKey ? [...selectedIds] : []
    marqueeRef.current = { x: event.clientX, y: event.clientY, base }
    grid.setPointerCapture(event.pointerId)
    setMarquee({ left: event.clientX - rect.left + grid.scrollLeft, top: event.clientY - rect.top + grid.scrollTop, width: 0, height: 0 })
    if (!base.length) onSelectionChange([], null)
  }
  const marqueeMove = event => {
    const start = marqueeRef.current
    if (!start) return
    const grid = event.currentTarget
    const rect = grid.getBoundingClientRect()
    const leftClient = Math.min(start.x, event.clientX)
    const topClient = Math.min(start.y, event.clientY)
    const rightClient = Math.max(start.x, event.clientX)
    const bottomClient = Math.max(start.y, event.clientY)
    setMarquee({
      left: leftClient - rect.left + grid.scrollLeft,
      top: topClient - rect.top + grid.scrollTop,
      width: rightClient - leftClient,
      height: bottomClient - topClient
    })
    const hits = [...grid.querySelectorAll('.image-card')].filter(card => {
      const cardRect = card.getBoundingClientRect()
      return cardRect.right >= leftClient && cardRect.left <= rightClient && cardRect.bottom >= topClient && cardRect.top <= bottomClient
    }).map(card => card.dataset.imageId)
    const next = [...new Set([...start.base, ...hits])]
    onSelectionChange(next, hits.at(-1) || start.base.at(-1))
  }
  const marqueeUp = event => {
    if (!marqueeRef.current) return
    marqueeRef.current = null
    setMarquee(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <section className="image-folder-shell" onDragOver={event => event.preventDefault()} onDrop={drop}>
    <div className="image-folder-head">
      <div><Images/><b>图片文件夹</b><span>{images.length} 张图片{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length} 张` : ''}</span></div>
      <div><button onClick={onAdd}><Plus/>添加图片</button><button className="image-clear" onClick={onClear}><X/>清空</button></div>
    </div>
    <div className="image-folder-grid" onPointerDown={marqueeDown} onPointerMove={marqueeMove} onPointerUp={marqueeUp} onPointerCancel={marqueeUp}>
      {images.map(image => <article key={image.id} data-image-id={image.id} className={`image-card ${selectedSet.has(image.id) ? 'selected' : ''} ${selectedId === image.id ? 'active' : ''}`} onClick={event => selectCard(event, image.id)}>
        <div className="image-card-thumb">{image.crop
          ? <CroppedImageCanvas image={image} className="image-card-cropped-thumb"/>
          : <img src={api.mediaUrl(image.path)} loading="lazy" draggable="false" onLoad={event => onMeta(image.id, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight, loaded: true, error: null })}/>}</div>
        <div className="image-card-name" title={image.name}>{image.name}</div>
        <button onClick={event => { event.stopPropagation(); onRemove(image.id) }}><X/></button>
      </article>)}
      <button className="image-add-card" onClick={onAdd}><Plus/><span>拖入或添加图片</span></button>
      {marquee && <div className="image-selection-marquee" style={marquee}/>}
    </div>
  </section>
}

function MediaPreview({ clip, hidden, controller, marks, ratio, ratioMode, audioZoom, setAudioZoom, updateTransform }) {
  const mountIds = useRef({ video: crypto.randomUUID(), audio: crypto.randomUUID() })
  const videoClip = clip?.mediaType === 'video' ? clip : null
  const audioClip = clip?.mediaType === 'audio' ? clip : null
  return <div className={`media-preview-host ${hidden ? 'media-preview-hidden' : ''}`}>
    <VideoPreview clip={videoClip} visible={Boolean(videoClip)} controller={controller} ratio={ratio} ratioMode={ratioMode} updateTransform={updateTransform} mountId={mountIds.current.video}/>
    <div className={`audio-preview-layer ${audioClip ? '' : 'media-surface-hidden'}`}>
      {audioClip && <AudioWaveEditor clip={audioClip} marks={marks} zoom={audioZoom} setZoom={setAudioZoom} controller={controller}/>}
    </div>
    <audio
      ref={controller.audioRef} data-mount-id={mountIds.current.audio} preload="auto"
      onLoadedMetadata={controller.onLoadedMetadata} onLoadedData={controller.onLoadedData}
      onCanPlay={controller.onCanPlay} onSeeked={controller.onSeeked}
      onTimeUpdate={controller.onTimeUpdate} onPlay={controller.onPlay}
      onPause={controller.onPause} onEnded={controller.onPause} onError={controller.onError}
    />
  </div>
}

function VideoPreview({ clip, visible, controller, ratio, ratioMode, updateTransform, mountId }) {
  const drag = useRef(null)
  const transform = clip?.transform || { scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }
  const outputRatio = ratio.replace(':', '/')
  const style = {
    transform: `translate(${transform.x || 0}px, ${transform.y || 0}px) rotate(${transform.rotation || 0}deg) scale(${(transform.scale || 100) / 100}) scaleX(${transform.flipH ? -1 : 1}) scaleY(${transform.flipV ? -1 : 1})`,
    objectFit: ratioMode === 'pad' ? 'contain' : 'cover'
  }
  const down = event => {
    if (!clip || event.button !== 0 || transform.scale <= 100) return
    event.preventDefault()
    drag.current = { x: event.clientX, y: event.clientY, startX: transform.x || 0, startY: transform.y || 0 }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('is-panning')
  }
  const move = event => {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    updateTransform({ x: drag.current.startX + event.clientX - drag.current.x, y: drag.current.startY + event.clientY - drag.current.y })
  }
  const up = event => {
    drag.current = null
    event.currentTarget.classList.remove('is-panning')
  }
  return <div className={`preview-frame pannable ${visible ? '' : 'media-surface-hidden'}`} style={{ aspectRatio: outputRatio }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <video
      ref={controller.videoRef} data-mount-id={mountId} preload="auto" crossOrigin="anonymous" style={style}
      onLoadedMetadata={controller.onLoadedMetadata} onLoadedData={controller.onLoadedData}
      onCanPlay={controller.onCanPlay} onSeeked={controller.onSeeked}
      onTimeUpdate={controller.onTimeUpdate} onPlay={controller.onPlay}
      onPause={controller.onPause} onEnded={controller.onPause} onError={controller.onError}
    />
    <LutPreviewCanvas videoRef={controller.videoRef} clipId={clip?.id} lut={clip?.lut} style={style}/>
    <div className="export-boundary"/>
  </div>
}

function LutPreviewCanvas({ videoRef, clipId, lut, style }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !clipId || !lut || lut.preset === 'none') return
    canvas.classList.remove('active')
    delete canvas.dataset.lutPreset
    delete canvas.dataset.lutError
    video.classList.remove('lut-source-hidden')
    let disposed = false
    let frameHandle = 0
    let usingVideoFrames = false
    const revealSource = error => {
      canvas.classList.remove('active')
      delete canvas.dataset.lutPreset
      if (error) canvas.dataset.lutError = error.message || String(error)
      video.classList.remove('lut-source-hidden')
    }
    const compile = (gl, type, source) => {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'LUT 着色器编译失败')
      return shader
    }
    const activate = async () => {
      const result = await api.getLutData(lut)
      if (disposed || !result?.ok || !result.size || !result.data) {
        if (!disposed && result?.error) canvas.dataset.lutError = result.error
        return
      }
      const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: false })
      if (!gl) { revealSource('当前显卡不支持 WebGL2 LUT 预览'); return }
      const vertex = compile(gl, gl.VERTEX_SHADER, `#version 300 es
        in vec2 position; in vec2 uv; out vec2 vUv;
        void main(){ vUv=uv; gl_Position=vec4(position,0.0,1.0); }`)
      const fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; precision highp sampler3D;
        in vec2 vUv; uniform sampler2D videoFrame; uniform sampler3D colorLut;
        uniform vec3 domainMin; uniform vec3 domainMax; out vec4 outputColor;
        void main(){
          vec4 source=texture(videoFrame,vUv);
          vec3 lookup=clamp((source.rgb-domainMin)/max(domainMax-domainMin,vec3(0.00001)),0.0,1.0);
          outputColor=vec4(texture(colorLut,lookup).rgb,source.a);
        }`)
      const program = gl.createProgram()
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'LUT 着色器链接失败')
      gl.useProgram(program)
      const quad = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1]), gl.STATIC_DRAW)
      const position = gl.getAttribLocation(program, 'position')
      const uv = gl.getAttribLocation(program, 'uv')
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8)
      const videoTexture = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, videoTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.uniform1i(gl.getUniformLocation(program, 'videoFrame'), 0)
      const lutTexture = gl.createTexture()
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTexture)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, result.size, result.size, result.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(result.data))
      gl.uniform1i(gl.getUniformLocation(program, 'colorLut'), 1)
      gl.uniform3fv(gl.getUniformLocation(program, 'domainMin'), result.domainMin || [0,0,0])
      gl.uniform3fv(gl.getUniformLocation(program, 'domainMax'), result.domainMax || [1,1,1])
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      const draw = () => {
        if (disposed || gl.isContextLost() || video.dataset.clipId !== clipId || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return
        const scale = Math.min(1, 1280 / video.videoWidth)
        const width = Math.max(2, Math.round(video.videoWidth * scale))
        const height = Math.max(2, Math.round(video.videoHeight * scale))
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height) }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, videoTexture)
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video) }
        catch (error) { revealSource(error); return }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        if (gl.getError() !== gl.NO_ERROR) { revealSource('LUT 画面渲染失败'); return }
        canvas.classList.add('active')
        canvas.dataset.lutPreset = lut.preset
        video.classList.add('lut-source-hidden')
      }
      const loop = () => {
        draw()
        if (disposed) return
        if (typeof video.requestVideoFrameCallback === 'function') {
          usingVideoFrames = true
          frameHandle = video.requestVideoFrameCallback(loop)
        } else frameHandle = requestAnimationFrame(loop)
      }
      video.addEventListener('loadeddata', draw)
      video.addEventListener('seeked', draw)
      video.addEventListener('emptied', revealSource)
      video.addEventListener('error', revealSource)
      const contextLost = event => { event.preventDefault(); revealSource('LUT 图形上下文暂时不可用') }
      canvas.addEventListener('webglcontextlost', contextLost)
      loop()
      canvas._lutCleanup = () => {
        video.removeEventListener('loadeddata', draw)
        video.removeEventListener('seeked', draw)
        video.removeEventListener('emptied', revealSource)
        video.removeEventListener('error', revealSource)
        canvas.removeEventListener('webglcontextlost', contextLost)
        if (usingVideoFrames && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameHandle)
        else cancelAnimationFrame(frameHandle)
        gl.deleteTexture(videoTexture); gl.deleteTexture(lutTexture); gl.deleteBuffer(quad); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment)
      }
    }
    activate().catch(error => { if (!disposed) revealSource(error) })
    return () => {
      disposed = true
      canvas._lutCleanup?.()
      delete canvas._lutCleanup
      canvas.classList.remove('active')
      delete canvas.dataset.lutPreset
      video.classList.remove('lut-source-hidden')
    }
  }, [videoRef, clipId, lut?.preset, lut?.path])
  return <canvas ref={canvasRef} className="lut-preview-canvas" style={style}/>
}

function PrecisionScrubber({ clip, time, marks, setMarks, controller }) {
  const progressRef = useRef(null)
  const rangeRef = useRef(null)
  const playheadRef = useRef(null)
  const inRef = useRef(null)
  const outRef = useRef(null)
  const draftRef = useRef(marks)
  const activeRef = useRef(null)
  useEffect(() => controller.subscribe(value => {
    if (progressRef.current) progressRef.current.value = value
    if (playheadRef.current && clip) playheadRef.current.style.left = `${pct(value)}%`
  }), [controller, clip?.id, clip?.start, clip?.end])
  const start = clip?.start ?? 0
  const end = clip?.end ?? 1
  const span = Math.max(0.001, end - start)
  const pct = value => Math.max(0, Math.min(100, (value - start) / span * 100))
  const paintMarks = next => {
    const entry = next.in ?? start
    const exit = next.out ?? end
    if (rangeRef.current) {
      rangeRef.current.style.left = `${pct(entry)}%`
      rangeRef.current.style.width = `${Math.max(0, pct(exit) - pct(entry))}%`
    }
    if (inRef.current) inRef.current.value = entry
    if (outRef.current) outRef.current.value = exit
  }
  useEffect(() => { if (clip) paintMarks(marks) }, [clip?.id, marks.in, marks.out])
  if (!clip || clip.pendingProbe || clip.proxyPending || clip.probeError || clip.proxyError || !clip.duration) return <div className="precision-scrubber disabled"/>
  const begin = kind => {
    activeRef.current = kind
    const currentIn = Number(inRef.current?.value)
    const currentOut = Number(outRef.current?.value)
    draftRef.current = {
      in: Number.isFinite(currentIn) ? currentIn : (marks.in ?? clip.start),
      out: Number.isFinite(currentOut) ? currentOut : (marks.out ?? clip.end)
    }
    controller.beginScrub()
  }
  const finish = () => {
    if (!activeRef.current) return
    const kind = activeRef.current
    activeRef.current = null
    if (kind === 'in' || kind === 'out') setMarks({ ...draftRef.current })
    controller.endScrub()
  }
  const progressInput = event => controller.seekTo(+event.currentTarget.value)
  const markInput = (kind, event) => {
    const currentMarks = draftRef.current
    const raw = +event.currentTarget.value
    const target = kind === 'in'
      ? Math.min(raw, (currentMarks.out ?? clip.end) - 0.04)
      : Math.max(raw, (currentMarks.in ?? clip.start) + 0.04)
    draftRef.current = { ...currentMarks, [kind]: target }
    paintMarks(draftRef.current)
    controller.seekTo(target)
  }
  const common = { min: clip.start, max: clip.end, step: 0.001 }
  return <div className="precision-scrubber">
    <div className="scrub-base"/>
    <div ref={rangeRef} className="marked-range" style={{ left: `${pct(marks.in ?? clip.start)}%`, width: `${Math.max(0, pct(marks.out ?? clip.end) - pct(marks.in ?? clip.start))}%` }}/>
    <span ref={playheadRef} className="playhead-marker" style={{ left: `${pct(time)}%` }}/>
    <input ref={progressRef} data-role="progress-range" className="scrub-range" type="range" {...common} defaultValue={time} onPointerDown={() => begin('progress')} onInput={progressInput} onPointerUp={finish} onPointerCancel={finish} onKeyDown={() => begin('progress')} onKeyUp={finish} onBlur={finish}/>
    <input ref={inRef} data-role="in-range" aria-label="入点" className="mark-range mark-range-in" type="range" {...common} defaultValue={marks.in ?? clip.start} onPointerDown={event => { event.stopPropagation(); begin('in') }} onInput={event => markInput('in', event)} onPointerUp={finish} onPointerCancel={finish} onKeyDown={() => begin('in')} onKeyUp={finish} onBlur={finish}/>
    <input ref={outRef} data-role="out-range" aria-label="出点" className="mark-range mark-range-out" type="range" {...common} defaultValue={marks.out ?? clip.end} onPointerDown={event => { event.stopPropagation(); begin('out') }} onInput={event => markInput('out', event)} onPointerUp={finish} onPointerCancel={finish} onKeyDown={() => begin('out')} onKeyUp={finish} onBlur={finish}/>
    <span className="mark-caption in">入</span><span className="mark-caption out">出</span>
  </div>
}

function AudioWaveEditor({ clip, marks, zoom, setZoom, controller }) {
  const inner = useRef(null)
  const scroll = useRef(null)
  const cursor = useRef(null)
  const cursorLabel = useRef(null)
  const pan = useRef(null)
  const dragging = useRef(false)
  const [viewportWidth, setViewportWidth] = useState(1)
  const span = Math.max(0.001, clip.end - clip.start)
  const pct = value => Math.max(0, Math.min(100, (value - clip.start) / span * 100))
  const visiblePeaks = useMemo(() => {
    if (!clip.visual?.length || !clip.duration) return clip.visual
    const first = Math.max(0, Math.floor(clip.start / clip.duration * clip.visual.length))
    const last = Math.min(clip.visual.length, Math.ceil(clip.end / clip.duration * clip.visual.length))
    return clip.visual.slice(first, Math.max(first + 1, last))
  }, [clip.visual, clip.duration, clip.start, clip.end])
  const waveformWidth = Math.max(viewportWidth, viewportWidth * zoom / 100)
  useLayoutEffect(() => {
    if (!scroll.current) return
    setViewportWidth(Math.max(1, scroll.current.clientWidth))
    const observe = new ResizeObserver(entries => setViewportWidth(Math.max(1, entries[0].contentRect.width)))
    observe.observe(scroll.current)
    return () => observe.disconnect()
  }, [clip.id])
  useEffect(() => controller.subscribe(value => {
    if (cursor.current) cursor.current.style.left = `${pct(value)}%`
    if (cursorLabel.current) cursorLabel.current.textContent = fmt(value)
  }), [controller, clip.id, clip.start, clip.end])
  const point = event => {
    const box = scroll.current
    const rect = box.getBoundingClientRect()
    const mouseX = event.clientX - rect.left
    const waveformX = mouseX + box.scrollLeft
    const position = Math.max(0, Math.min(1, waveformX / Math.max(1, waveformWidth)))
    return clip.start + position * span
  }
  const down = event => {
    if (event.button !== 0) return
    dragging.current = true
    controller.beginScrub()
    event.currentTarget.setPointerCapture(event.pointerId)
    controller.seekTo(point(event))
  }
  const move = event => {
    if (dragging.current && event.currentTarget.hasPointerCapture(event.pointerId)) controller.seekTo(point(event))
  }
  const up = () => {
    if (!dragging.current) return
    dragging.current = false
    controller.endScrub()
  }
  const wheel = event => {
    event.preventDefault()
    const box = scroll.current
    const rect = box.getBoundingClientRect()
    const mouseX = event.clientX - rect.left
    const waveformX = mouseX + box.scrollLeft
    const anchor = Math.max(0, Math.min(1, waveformX / Math.max(1, waveformWidth)))
    const next = Math.max(100, Math.min(1000, zoom + (event.deltaY < 0 ? 50 : -50)))
    setZoom(next)
    requestAnimationFrame(() => {
      const nextWidth = Math.max(viewportWidth, viewportWidth * next / 100)
      if (scroll.current) scroll.current.scrollLeft = Math.max(0, anchor * nextWidth - mouseX)
    })
  }
  const panDown = event => {
    if (event.button !== 1) return
    event.preventDefault()
    pan.current = { x: event.clientX, left: scroll.current.scrollLeft }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const panMove = event => {
    if (pan.current && event.currentTarget.hasPointerCapture(event.pointerId)) scroll.current.scrollLeft = pan.current.left - (event.clientX - pan.current.x)
  }
  return <div className="audio-editor">
    <div className="audio-editor-head"><span><AudioWaveform/>真实 PCM 波形</span><label><ZoomIn/>鼠标位置缩放 <b>{zoom}%</b></label></div>
    <div ref={scroll} className="audio-wave-scroll" onWheel={wheel} onPointerDown={panDown} onPointerMove={panMove} onPointerUp={() => { pan.current = null }} onPointerCancel={() => { pan.current = null }}>
      <div className="audio-wave-content" style={{ width: waveformWidth }}>
        <div ref={inner} className="audio-wave-inner" style={{ width: waveformWidth, left: 0 }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <Wave values={visiblePeaks}/>
          <div className="audio-selection" style={{ left: `${pct(marks.in ?? clip.start)}%`, width: `${Math.max(0, pct(marks.out ?? clip.end) - pct(marks.in ?? clip.start))}%` }}/>
          <div ref={cursor} className="audio-cursor" style={{ left: `${pct(controller.getTime())}%` }}><i/><span ref={cursorLabel}>{fmt(controller.getTime())}</span></div>
        </div>
      </div>
    </div>
  </div>
}

function Wave({ values, compact = false }) {
  const shown = compact && values?.length ? values.filter((_, index) => index % Math.ceil(values.length / 130) === 0) : values
  return <div className={`wave ${compact ? 'compact' : ''}`}>
    {shown?.length ? shown.map((value, index) => <i key={index} style={{ height: `${Math.max(3, value * 100)}%` }}/>) : <span className="wave-status">正在分析真实波形…</span>}
  </div>
}

function TimelineClip({ clip, active, dragging, onSelect, onRemove, onDragStart, onDragEnter, onDragEnd, onVisible, onRetry }) {
  const cardRef = useRef(null)
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible
  useEffect(() => {
    if (clip.pendingProbe || clip.probeError || clip.proxyPending || clip.proxyError || clip.visual || clip.visualLoading || clip.visualError) return
    const card = cardRef.current
    if (!card) return
    if (!('IntersectionObserver' in window)) {
      onVisibleRef.current?.()
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      onVisibleRef.current?.()
    }, { rootMargin: '120px' })
    observer.observe(card)
    return () => observer.disconnect()
  }, [clip.id, clip.pendingProbe, clip.probeError, clip.proxyPending, clip.proxyError, clip.visual, clip.visualLoading, clip.visualError])
  const changeTransition = patch => window.dispatchEvent(new CustomEvent('cutflow-transition', { detail: { id: clip.id, patch } }))
  const clipPeaks = useMemo(() => {
    if (clip.mediaType !== 'audio' || !clip.visual?.length || !clip.duration) return clip.visual
    const start = Math.floor(clip.start / clip.duration * clip.visual.length)
    const end = Math.ceil(clip.end / clip.duration * clip.visual.length)
    return clip.visual.slice(start, Math.max(start + 1, end))
  }, [clip])
  return <div
    ref={cardRef} draggable className={`clip ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${clip.mediaType}`}
    style={{ width: timelineClipWidth(clip.end - clip.start), viewTransitionName: `clip-${clip.id.replaceAll('-', '')}` }}
    onClick={event => { event.stopPropagation(); onSelect() }}
    onDragStart={onDragStart} onDragEnter={onDragEnter} onDragOver={event => event.preventDefault()} onDragEnd={onDragEnd}
  >
    <div className="clip-top"><GripVertical/><b>{clip.name}</b><span>{fmt(clip.end - clip.start)}</span></div>
    <div className="thumb">{clip.pendingProbe
      ? <div className="thumb-loading"><span className="loading-spinner"/><b>分析中…</b></div>
      : clip.probeError
        ? <div className="thumbnail-error" onClick={event => { event.stopPropagation(); onRetry() }}>素材分析失败<br/>点击重试</div>
        : clip.proxyPending
          ? <div className="thumb-loading"><span className="loading-spinner"/><b>生成预览代理…</b></div>
          : clip.proxyError
            ? <div className="thumbnail-error" onClick={event => { event.stopPropagation(); onRetry() }}>预览代理失败<br/>点击重试</div>
            : clip.mediaType === 'video'
              ? clip.visual ? <img src={clip.visual}/> : clip.visualError ? <div className="thumbnail-error" onClick={event => { event.stopPropagation(); onRetry() }}>提取失败<br/>点击重试</div> : <div className="thumb-loading"><Video/><b>生成首帧…</b></div>
              : clip.visualError ? <div className="thumbnail-error" onClick={event => { event.stopPropagation(); onRetry() }}>波形失败<br/>点击重试</div> : <Wave values={clipPeaks} compact/>}</div>
    <button onClick={event => { event.stopPropagation(); onRemove() }}><X/></button>
    {clip.mediaType === 'video' && <div className="transition-control" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <select value={clip.transition?.type || 'none'} onChange={event => changeTransition({ type: event.target.value })}>
        <option value="none">无转场</option><option value="fade">淡化</option><option value="wipeleft">向左擦除</option>
      </select>
      <input title="转场秒数" type="number" min="0.1" max="3" step="0.1" value={clip.transition?.duration || 0.5} onChange={event => changeTransition({ duration: +event.target.value })}/><span>秒</span>
    </div>}
  </div>
}

function Field({ label, hint, children, className = '' }) {
  return <div className={`field ${className}`}><div className="field-label"><label>{label}</label>{hint && <span>{hint}</span>}</div>{children}</div>
}

function DbControl({ value, onChange }) {
  const number = Number(value ?? 0)
  const muted = number <= -120
  return <div className="db-control">
    <div className="db-control-head"><button className={muted ? 'on' : ''} onClick={() => onChange(muted ? 0 : -120)}>{muted ? '取消静音' : '静音'}</button><div className="db-readout">{muted ? '-∞ dB' : `${number > 0 ? '+' : ''}${number.toFixed(1)} dB`}</div></div>
    <input className="db-slider" type="range" min="-24" max="12" step="0.5" value={muted ? -24 : number} onChange={event => onChange(+event.target.value)}/>
    <div className="db-ticks"><span>-24 dB</span><span className="db-zero">0 dB</span><span>+12 dB</span></div>
  </div>
}

function ExportPanelV2({ settings, setSettings, current, updateCurrent, updateTransform, resetTransform, applyLut, timelines, exporting, progress, doExport, imageMode, imageCurrent, updateImageTransform, resetImageTransform, doImageExport, beginImageCrop, imageCropEditing, imageCropRatio }) {
  const set = patch => setSettings({ ...settings, ...patch })
  if (imageMode && imageCurrent) {
    const imageTransform = imageCurrent.transform || { scale: 100, rotation: 0 }
    const radians = imageTransform.rotation * Math.PI / 180
    const sourceWidth = Math.round(Math.abs(imageCurrent.width * Math.cos(radians)) + Math.abs(imageCurrent.height * Math.sin(radians)))
    const sourceHeight = Math.round(Math.abs(imageCurrent.width * Math.sin(radians)) + Math.abs(imageCurrent.height * Math.cos(radians)))
    const sourceRatio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 1
    const displayWidth = settings.imageResolutionPreset === 'original' ? sourceWidth : settings.imageWidth
    const displayHeight = settings.imageResolutionPreset === 'original' ? sourceHeight : settings.imageHeight
    const gcd = (a, b) => b ? gcd(b, a % b) : a
    const ratioDivisor = displayWidth > 0 && displayHeight > 0 ? gcd(Math.round(displayWidth), Math.round(displayHeight)) : 1
    const dimensionRatio = displayWidth > 0 && displayHeight > 0 ? `${Math.round(displayWidth) / ratioDivisor}:${Math.round(displayHeight) / ratioDivisor}` : '—'
    const sizeStops = [0, 1, 2, 5, 10]
    const sizeToSlider = size => {
      const value = Math.max(0, Math.min(10, Number(size) || 0))
      const upper = sizeStops.findIndex(stop => stop >= value)
      if (upper <= 0) return 0
      const lower = upper - 1
      return lower + (value - sizeStops[lower]) / (sizeStops[upper] - sizeStops[lower])
    }
    const sliderToSize = slider => {
      const position = Math.max(0, Math.min(4, Number(slider) || 0))
      const lower = Math.min(3, Math.floor(position))
      const fraction = position - lower
      return Math.round((sizeStops[lower] + (sizeStops[lower + 1] - sizeStops[lower]) * fraction) * 10) / 10
    }
    const setDimension = (axis, raw) => {
      const value = Math.max(0, Math.min(20000, Math.round(Number(raw) || 0)))
      if (!settings.imageLockRatio || !value || !sourceRatio) return set({ imageResolutionPreset: 'custom', [axis]: value })
      if (axis === 'imageWidth') set({ imageResolutionPreset: 'custom', imageWidth: value, imageHeight: Math.max(1, Math.round(value / sourceRatio)) })
      else set({ imageResolutionPreset: 'custom', imageHeight: value, imageWidth: Math.max(1, Math.round(value * sourceRatio)) })
    }
    const selectResolution = value => {
      if (value === 'original') return set({ imageResolutionPreset: 'original', imageWidth: 0, imageHeight: 0 })
      const [width, height] = value.split('x').map(Number)
      set({ imageResolutionPreset: value, imageWidth: width, imageHeight: height })
    }
    return <aside>
      <div className="aside-title"><Settings2/><h2>导出设置</h2></div>
      <Field label="保存设置">
        <div className="save-options"><button className={settings.saveMode === 'ask' ? 'on' : ''} onClick={() => set({ saveMode: 'ask' })}>每次导出时选择</button><button className={settings.saveMode === 'folder' ? 'on' : ''} onClick={() => set({ saveMode: 'folder' })}>使用默认文件夹</button></div>
        {settings.saveMode === 'folder' && <button className="folder" onClick={() => api.chooseOutputDir().then(path => path && set({ outputDir: path }))}><FolderOpen/><span>{settings.outputDir || '选择默认文件夹'}</span></button>}
      </Field>
      <Field label="文件名设置"><div className="fixed"><b>跟随图片原文件名</b><span>批量导出自动保留</span><CheckCircle2/></div></Field>
      <section className="settings-group image-settings-group">
        <h3 className="settings-section"><Images/>图片设置</h3>
        <Field label="当前图片缩放" hint={`${imageTransform.scale}%`}>
          <input type="range" min="10" max="300" step="5" value={imageTransform.scale} onChange={event => updateImageTransform({ scale: +event.target.value })}/>
        </Field>
        <Field label="图片旋转" hint={`${imageTransform.rotation}°`}>
          <input type="range" min="0" max="359" step="1" value={imageTransform.rotation} onChange={event => updateImageTransform({ rotation: +event.target.value })}/>
          <div className="image-rotation-tools"><button onClick={() => updateImageTransform({ rotation: (imageTransform.rotation + 270) % 360 })}><RotateCcw/>向左 90°</button><button onClick={() => updateImageTransform({ rotation: (imageTransform.rotation + 90) % 360 })}><RotateCw/>向右 90°</button></div>
          <button className="transform-reset" onClick={resetImageTransform}><RotateCcw/>还原缩放与旋转</button>
        </Field>
        <Field label="缩放、旋转与裁切应用范围">
          <div className="setting-scope"><button className={settings.imageTransformScope === 'selected' ? 'on' : ''} onClick={() => set({ imageTransformScope: 'selected' })}>应用选中图片</button><button className={settings.imageTransformScope === 'all' ? 'on' : ''} onClick={() => set({ imageTransformScope: 'all' })}>应用所有图片</button></div>
        </Field>
        <Field label="裁切比例" hint={imageCropEditing ? '在预览窗口调整后应用' : imageCurrent.crop ? '已应用裁切' : ''}>
          <div className="crop-presets">{[['free','自由'],['16:9','16:9'],['4:3','4:3'],['1:1','1:1'],['3:2','3:2'],['9:16','9:16']].map(([value,label]) => <button key={value} className={imageCropEditing && imageCropRatio === value ? 'on' : ''} onClick={() => beginImageCrop(value)}>{label}</button>)}</div>
        </Field>
        <Field label="输出分辨率" hint={settings.imageResolutionPreset === 'original' ? '跟随每张原图' : `${settings.imageWidth} × ${settings.imageHeight}`}>
          <select className="image-resolution-preset" value={settings.imageResolutionPreset} onChange={event => selectResolution(event.target.value)}><option value="original">原始分辨率</option><option value="320x240">低分辨率 · 320 × 240</option><option value="640x480">低分辨率 · 640 × 480</option><option value="854x480">480p · 854 × 480</option><option value="1024x768">低分辨率 · 1024 × 768</option><option value="1280x720">高清 · 1280 × 720</option><option value="1080x1080">方形 · 1080 × 1080</option><option value="1080x1350">竖图 · 1080 × 1350</option><option value="1920x1080">全高清 · 1920 × 1080</option><option value="2560x1440">2K · 2560 × 1440</option><option value="3840x2160">4K · 3840 × 2160</option>{settings.imageResolutionPreset === 'custom' && <option value="custom">自定义</option>}</select>
          <div className="image-resolution-row"><label>宽<input type="number" min="1" max="20000" value={displayWidth || 0} onChange={event => setDimension('imageWidth', event.target.value)}/></label><span>×</span><label>高<input type="number" min="1" max="20000" value={displayHeight || 0} onChange={event => setDimension('imageHeight', event.target.value)}/></label></div>
          <div className="image-dimension-ratio">对应比例 <b>{dimensionRatio}</b></div>
          <label className="image-ratio-lock"><input type="checkbox" checked={settings.imageLockRatio} onChange={event => set({ imageLockRatio: event.target.checked })}/><span>锁定当前图片比例</span></label>
          <button className="image-original-size" onClick={() => selectResolution('original')}>恢复原图分辨率</button>
        </Field>
        <Field label="目标文件体积" hint={settings.imageTargetSizeMb ? `不超过约 ${settings.imageTargetSizeMb} MB` : '不限制'}>
          <div className="image-size-slider">
            <input type="range" min="0" max="4" step="0.05" value={sizeToSlider(settings.imageTargetSizeMb)} onChange={event => set({ imageTargetSizeMb: sliderToSize(event.target.value) })}/>
            <div className="image-size-marks">{[[0,'不限制'],[1,'1M'],[2,'2M'],[5,'5M'],[10,'10M']].map(([value,label], index) => <button type="button" key={value} className={settings.imageTargetSizeMb === value ? 'on' : ''} style={{ left: `${index * 25}%` }} onClick={() => set({ imageTargetSizeMb: value })}><i/><span>{label}</span></button>)}</div>
          </div>
          <small className="image-size-note">JPG、WebP 会自动调整压缩质量；无损格式按最佳压缩输出。</small>
        </Field>
        <Field label="导出格式"><select value={settings.imageFormat} onChange={event => set({ imageFormat: event.target.value })}><option value="jpg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="tiff">TIFF</option><option value="bmp">BMP</option></select></Field>
        <button className="export image-export" disabled={exporting} onClick={doImageExport}><Images/>按原文件名批量导出</button>
      </section>
      {exporting && <div className="progress"><div><span>正在处理图片…</span><b>{progress}%</b></div><i><em style={{ width: `${progress}%` }}/></i><button onClick={() => api.cancelExport()}>取消导出</button></div>}
    </aside>
  }
  const hasVideo = current?.mediaType === 'video'
  const hasAudio = Boolean(current)
  const hasMedia = Boolean(current)
  const transform = current?.transform || { scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }
  const selectedLut = current?.lut || { preset: 'none', path: '', name: '无' }
  const chooseCustomLut = async () => {
    const lutPath = await api.chooseLut()
    if (!lutPath) return
    applyLut({ preset: 'custom', path: lutPath, name: fileName(lutPath) })
  }
  if (!hasMedia) return <aside><div className="settings-empty"><Settings2/><h2>暂无设置</h2><p>拖入视频、音频或图片后显示对应选项</p></div></aside>
  return <aside>
    <div className="aside-title"><Settings2/><h2>导出设置</h2></div>
    {hasMedia && <Field label="保存设置">
      <div className="save-options"><button className={settings.saveMode === 'ask' ? 'on' : ''} onClick={() => set({ saveMode: 'ask' })}>每次导出时选择</button><button className={settings.saveMode === 'folder' ? 'on' : ''} onClick={() => set({ saveMode: 'folder' })}>使用默认文件夹</button></div>
      {settings.saveMode === 'folder' && <button className="folder" onClick={() => api.chooseOutputDir().then(path => path && set({ outputDir: path }))}><FolderOpen/><span>{settings.outputDir || '选择默认文件夹'}</span></button>}
    </Field>}
    {hasMedia && <Field label="文件名设置">
      <div className="save-options"><button className={settings.namingMode === 'firstClip' ? 'on' : ''} onClick={() => set({ namingMode: 'firstClip' })}>按首个片段名字</button><button className={settings.namingMode === 'timeline' ? 'on' : ''} onClick={() => set({ namingMode: 'timeline' })}>按时间轴名字导出</button></div>
    </Field>}
    {hasVideo && <section className="settings-group video-settings-group">
      <h3 className="settings-section"><Video/>视频设置</h3>
      <Field label="画幅比例">
        <div className="seg">{[['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:3', '4:3']].map(([value, label]) => <button key={value} className={settings.ratio === value ? 'on' : ''} onClick={() => set({ ratio: value })}>{label}</button>)}</div>
        <div className="ratio-mode"><button className={settings.ratioMode === 'pad' ? 'on' : ''} onClick={() => set({ ratioMode: 'pad' })}>黑边填充</button><button className={settings.ratioMode === 'crop' ? 'on' : ''} onClick={() => set({ ratioMode: 'crop' })}>缩放填充</button></div>
      </Field>
      <Field label="LUT">
        <div className="setting-scope"><button className={settings.lutScope === 'selected' ? 'on' : ''} onClick={() => set({ lutScope: 'selected' })}>应用选中片段</button><button className={settings.lutScope === 'all' ? 'on' : ''} onClick={() => set({ lutScope: 'all' })}>应用所有片段</button></div>
        <div className="lut-row"><select value={selectedLut.preset} onChange={event => applyLut({ preset: event.target.value, path: '', name: event.target.selectedOptions[0].text })}><option value="none">无</option><option value="sony-slog3">Sony S-Log3 / S-Gamut3.Cine → Rec.709</option><option value="sony-slog2">Sony S-Log2 / S-Gamut → Rec.709</option><option value="panasonic-vlog">Panasonic V-Log / V-Gamut → V-709</option>{selectedLut.preset === 'custom' && <option value="custom">自定义 LUT</option>}</select><button className="lut-file" onClick={chooseCustomLut}>选择 .cube</button></div>
        {selectedLut.preset === 'custom' && <div className="lut-name">{selectedLut.name || selectedLut.path}</div>}
      </Field>
      <Field label="当前片段缩放" hint={`${transform.scale}%`}>
        <input disabled={!current || current.mediaType !== 'video'} type="range" min="50" max="300" step="5" value={transform.scale} onChange={event => updateTransform({ scale: +event.target.value })}/>
      </Field>
      <Field label="旋转、翻转与位置">
        <div className="transform-tools"><button disabled={!current || current.mediaType !== 'video'} onClick={() => updateTransform({ rotation: (transform.rotation + 90) % 360 })}><RotateCw/>旋转 90°</button><button disabled={!current || current.mediaType !== 'video'} className={transform.flipH ? 'on' : ''} onClick={() => updateTransform({ flipH: !transform.flipH })}><FlipHorizontal2/>水平翻转</button><button disabled={!current || current.mediaType !== 'video'} className={transform.flipV ? 'on' : ''} onClick={() => updateTransform({ flipV: !transform.flipV })}><FlipVertical2/>垂直翻转</button></div>
        <button className="transform-reset" disabled={!current || current.mediaType !== 'video'} onClick={resetTransform}><RotateCcw/>还原缩放与位置</button>
      </Field>
      <Field label="缩放旋转应用范围">
        <div className="setting-scope"><button className={settings.transformScope === 'selected' ? 'on' : ''} onClick={() => set({ transformScope: 'selected' })}>应用选中片段</button><button className={settings.transformScope === 'all' ? 'on' : ''} onClick={() => set({ transformScope: 'all' })}>应用所有片段</button></div>
      </Field>
      <Field label="分辨率与帧率"><div className="audio-row"><select value={settings.resolution} onChange={event => set({ resolution: event.target.value })}><option value="original">跟随原视频</option><option value="2160p">4K</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option></select><select value={settings.fps} onChange={event => set({ fps: +event.target.value })}>{[24, 25, 30, 50, 60].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></div></Field>
      <Field label="视频格式"><select value={settings.videoFormat} onChange={event => set({ videoFormat: event.target.value })}><option value="mp4">MP4 · H.264</option><option value="mov">MOV · ProRes 422 HQ</option><option value="mov-alpha">MOV · ProRes 4444（透明通道）</option></select></Field>
      <Field label="输出码率" hint={`${(settings.bitrate / 1000).toFixed(settings.bitrate % 1000 ? 1 : 0)} Mbps`}>
        <input type="range" min="1000" max="50000" step="500" value={settings.bitrate} onChange={event => set({ bitrate: +event.target.value })}/>
        <div className="bitrate-presets">{[2000, 6000, 10000, 20000, 30000, 50000].map(rate => <button key={rate} className={settings.bitrate === rate ? 'on' : ''} onClick={() => set({ bitrate: rate })}>{rate / 1000}M</button>)}</div>
      </Field>
      <Field label="视频导出方式">
        <div className="save-options"><button className={settings.videoExportUnit === 'timeline' ? 'on' : ''} onClick={() => set({ videoExportUnit: 'timeline' })}>整条时间轴</button><button className={settings.videoExportUnit === 'clip' ? 'on' : ''} onClick={() => set({ videoExportUnit: 'clip' })}>按片段分别导出</button></div>
      </Field>
      <button className="export" disabled={exporting} onClick={() => doExport('video')}><Download/>{settings.videoExportUnit === 'clip' ? '按片段分别导出' : '按时间轴分别导出'}</button>
    </section>}
    {hasAudio && <section className="settings-group">
      <h3 className="settings-section"><Music2/>音频设置</h3>
      {current && <Field label="当前片段音量"><DbControl value={current.gainDb ?? 0} onChange={gainDb => updateCurrent({ gainDb })}/></Field>}
      <Field label="全部音频总音量"><DbControl value={settings.masterGainDb ?? 0} onChange={masterGainDb => set({ masterGainDb })}/></Field>
      <Field label="统一响度">
        <label className="normalize"><input type="checkbox" checked={settings.normalizeAudio} onChange={event => set({ normalizeAudio: event.target.checked })}/><span>使用 EBU R128 测量算法，目标 {settings.loudnessTarget} LUFS</span></label>
        {settings.normalizeAudio && <div className="loudness-options"><button className={settings.loudnessTarget === -23 ? 'on' : ''} onClick={() => set({ loudnessTarget: -23 })}><b>-23 LUFS</b><span>电视广播</span></button><button className={settings.loudnessTarget === -16 ? 'on' : ''} onClick={() => set({ loudnessTarget: -16 })}><b>-16 LUFS</b><span>网络视频</span></button></div>}
      </Field>
      <div className="audio-row"><select value={settings.audioFormat} onChange={event => set({ audioFormat: event.target.value })}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="m4a">M4A</option></select><select value={settings.audioBitrate} onChange={event => set({ audioBitrate: +event.target.value })}><option value="128">128 kbps</option><option value="192">192 kbps</option><option value="320">320 kbps</option></select></div>
      <Field label="声音导出方式">
        <div className="save-options"><button className={settings.audioExportUnit === 'timeline' ? 'on' : ''} onClick={() => set({ audioExportUnit: 'timeline' })}>整条时间轴</button><button className={settings.audioExportUnit === 'clip' ? 'on' : ''} onClick={() => set({ audioExportUnit: 'clip' })}>按片段分别导出</button></div>
      </Field>
      <button className="audio-export" disabled={exporting} onClick={() => doExport('audio')}><Music2/>{settings.audioExportUnit === 'clip' ? '按片段分别导出' : '整条声音导出'}</button>
    </section>}
    {exporting && <div className="progress"><div><span>正在处理…</span><b>{progress}%</b></div><i><em style={{ width: `${progress}%` }}/></i><button onClick={() => api.cancelExport()}>取消导出</button></div>}
  </aside>
}

createRoot(document.getElementById('root')).render(<App/>)
