import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Upload, Play, Pause, Scissors, GripVertical, Music2, Settings2,
  Download, Plus, X, CheckCircle2, FolderOpen, RotateCw, FlipHorizontal2,
  FlipVertical2, ZoomIn, LogIn, LogOut, AudioWaveform, Video, Minus,
  Maximize2, Minimize2, RotateCcw
} from 'lucide-react'
import './styles.css'

const api = window.cutflow || {
  filePath: file => file.path,
  mediaUrl: path => `file://${path}`,
  openMedia: async () => [],
  openAudio: async () => [],
  chooseOutputDir: async () => null,
  chooseLut: async () => null,
  prepareMedia: async path => ({ ok: true, previewPath: path }),
  getThumbnail: async () => ({ ok: false }),
  getWaveform: async () => ({ ok: false }),
  chooseOutput: async () => null,
  exportMedia: async () => ({ ok: false, error: '请在桌面应用中运行' }),
  cancelExport: async () => {},
  onProgress: () => () => {},
  onProxyReady: () => () => {},
  windowMinimize: () => {},
  windowMaximize: () => {},
  windowClose: () => {}
}

const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|m4v|mxf|mts|m2ts|m2t|ts|mpg|mpeg|vob|3gp)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg)$/i
const fileName = path => path.split(/[\\/]/).pop()
const baseName = path => fileName(path).replace(/\.[^.]+$/, '')
const safeName = value => (value || '时间轴').replace(/[<>:"/\\|?*]/g, '_').trim() || '时间轴'
const outputBaseName = (timeline, namingMode) => safeName(namingMode === 'firstClip'
  ? baseName(timeline?.clips?.[0]?.name || timeline?.name)
  : timeline?.name)
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
  const playFromIn = async () => {
    const activeClip = clipRef.current
    const element = activeElement()
    if (!activeClip || !element || element.dataset.clipId !== activeClip.id) return
    if (!element.paused) return element.pause()
    const entry = Math.max(activeClip.start, marksRef.current.in ?? activeClip.start)
    const exit = Math.min(activeClip.end, marksRef.current.out ?? activeClip.end)
    if (exit - entry < 0.04) return show('入出点区间太短，无法播放')
    settlingTargetRef.current = entry
    seekTo(entry, { commit: true, immediate: true })
    await waitForPosition(entry)
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
  const [toast, setToast] = useState('')
  const [previewStatus, setPreviewStatus] = useState({ state: 'idle', message: '' })
  const [audioZoom, setAudioZoom] = useState(100)
  const [maximized, setMaximized] = useState(false)
  const [importChoice, setImportChoice] = useState(null)
  const [settings, setSettings] = useState({
    ratio: 'original', ratioMode: 'crop', resolution: '1080p', fps: 30,
    bitrate: 8000, audioFormat: 'mp3', audioBitrate: 192,
    outputDir: '', saveMode: 'ask', namingMode: 'timeline', normalizeAudio: false,
    loudnessTarget: -16, masterGainDb: 0, transformScope: 'selected', lutScope: 'selected',
    globalLut: { preset: 'none', path: '', name: '无' }
  })

  const activeTimeline = timelines.find(item => item.id === activeTimelineId) || timelines[0]
  const clips = activeTimeline?.clips || []
  const current = clips.find(clip => clip.id === selected) || null
  const hasTimelineClips = timelines.some(timeline => timeline.clips.length)

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

  useEffect(() => api.onProgress(setProgress), [])

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
    const nextMarks = { in: current.start, out: current.end }
    marksRef.current = nextMarks
    setMarks(nextMarks)
    controller.loadClip(current)
  }, [current?.id, current?.previewPath])

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

  const makeClip = async (path, guessedType) => {
    show(guessedType === 'video' ? `正在准备预览代理：${fileName(path)}` : `正在读取音频：${fileName(path)}`)
    const prepared = await api.prepareMedia(path)
    if (!prepared.ok) {
      show(`无法导入 ${fileName(path)}：${prepared.error}`)
      return null
    }
    const mediaType = prepared.mediaType || guessedType
    return {
      id: crypto.randomUUID(), path, previewPath: prepared.previewPath || path,
      name: fileName(path), mediaType, width: prepared.width, height: prepared.height,
      duration: prepared.duration || 0, start: 0, end: prepared.duration || 0,
      visual: null, proxied: prepared.proxied, proxyPending: prepared.proxyPending, gainDb: 0,
      lut: { preset: 'none', path: '', name: '无' },
      transition: { type: 'none', duration: 0.5 },
      transform: { scale: 100, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }
    }
  }

  const analyzeClip = clip => {
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
        clips: timeline.clips.map(item => item.id === clip.id ? { ...item, visual, visualError: null } : item)
      })))
    }).catch(error => {
      setTimelines(old => old.map(timeline => ({ ...timeline, clips: timeline.clips.map(item => item.id === clip.id ? { ...item, visualError: error.message } : item) })))
      show(`媒体分析失败：${error.message}`)
    })
  }

  const addPaths = async (paths, targetTimelineId = activeTimeline?.id) => {
    const unique = [...new Set(paths.filter(Boolean))]
    const mediaPaths = unique.filter(path => VIDEO_EXT.test(path) || AUDIO_EXT.test(path))
    if (!mediaPaths.length || !targetTimelineId) return
    show(`正在分析 ${mediaPaths.length} 个素材…`)
    const prepared = (await Promise.all(mediaPaths.map(path => makeClip(path, VIDEO_EXT.test(path) ? 'video' : 'audio')))).filter(Boolean)
    if (!prepared.length) return
    setTimelines(old => old.map(timeline => timeline.id === targetTimelineId
      ? { ...timeline, clips: [...timeline.clips, ...prepared] }
      : timeline))
    setActiveTimelineId(targetTimelineId)
    setSelected(prepared.at(-1).id)
    prepared.forEach(analyzeClip)
    show(`已导入 ${prepared.length} 个素材${prepared.some(clip => clip.proxied) ? '，并生成流畅预览代理' : ''}`)
  }

  const requestImport = (paths, targetTimelineId = activeTimeline?.id) => {
    const clean = paths.filter(Boolean)
    const mediaPaths = clean.filter(path => VIDEO_EXT.test(path) || AUDIO_EXT.test(path))
    if (!hasTimelineClips && mediaPaths.length > 1) {
      setImportChoice({ paths: clean, targetTimelineId })
      return
    }
    addPaths(clean, targetTimelineId)
  }

  const importTogether = () => {
    if (!importChoice) return
    const choice = importChoice
    setImportChoice(null)
    addPaths(choice.paths, choice.targetTimelineId)
  }

  const importSeparately = () => {
    if (!importChoice) return
    const mediaPaths = importChoice.paths.filter(path => VIDEO_EXT.test(path) || AUDIO_EXT.test(path))
    const firstEmpty = timelines.find(timeline => !timeline.clips.length)
    const lanes = mediaPaths.map((path, index) => ({
      id: index === 0 && firstEmpty ? firstEmpty.id : crypto.randomUUID(),
      name: baseName(path),
      clips: []
    }))
    setTimelines(old => {
      const usedFirst = firstEmpty && lanes.some(lane => lane.id === firstEmpty.id)
      const retained = usedFirst ? old.map(timeline => timeline.id === firstEmpty.id ? lanes[0] : timeline) : old
      const additions = lanes.filter(lane => !retained.some(timeline => timeline.id === lane.id))
      return [...retained, ...additions]
    })
    setImportChoice(null)
    lanes.forEach((lane, index) => addPaths([mediaPaths[index]], lane.id))
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
    const second = { ...current, id: crypto.randomUUID(), start: locatedTime, name: `${current.name.replace(/ · 片段 \d+$/, '')} · 片段` }
    setClips(old => old.flatMap(clip => clip.id === current.id ? [{ ...clip, end: locatedTime }, second] : clip))
    setSelected(second.id)
    analyzeClip(second)
  }

  const applyMarks = () => {
    const entry = marksRef.current.in
    const exit = marksRef.current.out
    if (entry == null || exit == null || exit - entry < 0.1) return show('出点必须晚于入点')
    setClips(old => old.map(clip => clip.id === selected ? { ...clip, start: entry, end: exit } : clip))
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
    const populated = timelines.filter(timeline => timeline.clips.length)
    const ready = mode === 'video'
      ? populated.filter(timeline => timeline.clips.some(clip => clip.mediaType === 'video'))
      : populated
    if (!ready.length) return show(mode === 'video' ? '没有可导出的视频时间轴' : '没有可导出的时间轴')
    const extension = mode === 'video' ? 'mp4' : settings.audioFormat
    let directory = settings.saveMode === 'folder' ? settings.outputDir : ''
    if (ready.length > 1 && !directory) directory = await api.chooseOutputDir()
    if (ready.length > 1 && !directory) return
    setExporting(true)
    setProgress(0)
    const usedNames = new Map()
    for (let index = 0; index < ready.length; index += 1) {
      const timeline = ready[index]
      const baseOutputName = outputBaseName(timeline, settings.namingMode)
      const duplicateIndex = usedNames.get(baseOutputName) || 0
      usedNames.set(baseOutputName, duplicateIndex + 1)
      const name = duplicateIndex ? `${baseOutputName}_${duplicateIndex + 1}` : baseOutputName
      const output = directory
        ? `${directory}${directory.includes('\\') ? '\\' : '/'}${name}.${extension}`
        : await api.chooseOutput(mode, settings.audioFormat, name)
      if (!output) continue
      const result = await api.exportMedia({ clips: timeline.clips, output, mode, settings })
      if (!result.ok) {
        setExporting(false)
        return show(result.error || '导出失败')
      }
      setProgress(Math.round((index + 1) / ready.length * 100))
    }
    setExporting(false)
    show(`已按名称导出 ${ready.length} 条时间轴`)
  }

  const rootDrop = event => {
    event.preventDefault()
    requestImport([...event.dataTransfer.files].map(api.filePath).filter(Boolean))
  }

  // Development-only bridge for the Electron smoke test. It exercises the
  // same import, time controller, transform and export paths as the visible UI.
  if (new URLSearchParams(window.location.search).get('smoke') === '1') {
    window.__cutflowTest = {
      importPaths: paths => addPaths(paths),
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
      split,
      removeSelected: () => current && removeClip(activeTimeline.id, current.id),
      transform: patch => updateTransform(patch),
      setClipLut: (clipId, lut) => setTimelines(old => old.map(timeline => ({ ...timeline, clips: timeline.clips.map(clip => clip.id === clipId ? { ...clip, lut } : clip) }))),
      outputName: (timelineId, namingMode) => outputBaseName(timelines.find(timeline => timeline.id === timelineId), namingMode),
      toggle: controller.toggle,
      pause: controller.pause,
      exportActive: (output, mode, overrides = {}) => api.exportMedia({
        clips: activeTimeline?.clips || [], output, mode,
        settings: { ...settings, ...overrides }
      }),
      state: () => {
        const video = controller.videoRef.current
        const audio = controller.audioRef.current
        return {
          selected, playing, time: controller.getTime(), marks: controller.getMarks(), audioZoom,
          previewStatus, activeTimelineId,
          timelines: timelines.map(timeline => ({
            id: timeline.id, name: timeline.name,
            clips: timeline.clips.map(item => ({
              id: item.id, name: item.name, path: item.path, previewPath: item.previewPath,
              mediaType: item.mediaType, start: item.start, end: item.end,
              duration: item.duration, proxied: item.proxied,
              visualReady: item.mediaType === 'video' ? /^data:image\/jpeg/.test(item.visual || '') : Boolean(item.visual?.length),
              visualPoints: Array.isArray(item.visual) ? item.visual.length : 0,
              visualError: item.visualError || null, transform: item.transform, lut: item.lut
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
      <div className="brand"><div className="logo"><Scissors size={20}/></div><span>剪影工坊</span></div>
      <div className="window-controls">
        <button onClick={api.windowMinimize}><Minus/></button>
        <button onClick={async () => setMaximized(await api.windowMaximize())}>{maximized ? <Minimize2/> : <Maximize2/>}</button>
        <button className="close" onClick={api.windowClose}><X/></button>
      </div>
    </header>
    <main>
      <section className="workspace">
        <div className={`viewer ${current?.mediaType === 'audio' ? 'audio-viewer' : ''}`}>
          <MediaPreview
            clip={current} hidden={!current} controller={controller}
            marks={marks} ratio={settings.ratio} ratioMode={settings.ratioMode}
            audioZoom={audioZoom} setAudioZoom={setAudioZoom} updateTransform={updateTransform}
          />
          {current && previewStatus.state !== 'ready' && previewStatus.state !== 'idle' && <div className={`preview-status ${previewStatus.state}`}><span className="preview-status-dot"/><b>{previewStatus.message}</b></div>}
          {current
            ? <div className="viewer-title">{current.name}<span>{current.mediaType === 'audio' ? '音频' : '视频'} · {fmt(current.end - current.start)}</span></div>
            : <div className="empty" onClick={() => api.openMedia().then(paths => requestImport(paths))}>
                <div className="drop-icon"><Upload/></div>
                <h2>拖入视频或音频</h2>
                <button><FolderOpen/>选择文件</button>
              </div>}
        </div>

        <>
          <div className="controls">
            <button disabled={!current} onClick={playing ? controller.pause : controller.playFromIn}>{playing ? <Pause/> : <Play/>}</button>
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
        </>

        <>
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
                      onRetry={() => analyzeClip(clip)}
                    />)}
                    <button className="add-card" onClick={event => { event.stopPropagation(); api.openMedia().then(paths => addPaths(paths, timeline.id)) }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); addPaths([...event.dataTransfer.files].map(api.filePath), timeline.id) }}>
                      <Plus/>{timeline.clips.length ? '添加' : '拖入或选择文件'}
                    </button>
                  </div>
                </section>
              })}
            </div>
            <button className="new-timeline-drop" onClick={newTimeline} onDragOver={event => event.preventDefault()} onDrop={newTimelineFromDrop}><Plus/>新建时间轴 · 可拖入文件新建</button>
          </>
      </section>
      <ExportPanelV2
        settings={settings} setSettings={setSettings} current={current}
        updateCurrent={updateCurrent} updateTransform={updateTransformScoped} resetTransform={resetTransformScoped} applyLut={applyLut}
        timelines={timelines} exporting={exporting} progress={progress} doExport={doExport}
      />
    </main>
    {toast && <div className="toast"><CheckCircle2/>{toast}</div>}
    {importChoice && <div className="import-choice-overlay" onClick={() => setImportChoice(null)}>
      <div className="import-choice-modal" onClick={event => event.stopPropagation()}>
        <div className="import-choice-icon"><Upload/></div>
        <h2>多个媒体如何导入？</h2>
        <p>检测到同时拖入了多个视频或音频，请选择时间轴组织方式。</p>
        <div className="import-choice-actions">
          <button className="primary" onClick={importTogether}>导入同一时间轴</button>
          <button onClick={importSeparately}>分别建立时间轴</button>
        </div>
      </div>
    </div>}
  </div>
}

function TimeReadout({ controller, fallback }) {
  const ref = useRef(null)
  useEffect(() => controller.subscribe(value => { if (ref.current) ref.current.textContent = fmt(value) }), [controller])
  return <span ref={ref}>{fmt(fallback)}</span>
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
  const outputRatio = ratio === 'original'
    ? clip?.width && clip?.height ? `${clip.width}/${clip.height}` : '16/9'
    : ratio.replace(':', '/')
  const style = {
    transform: `translate(${transform.x || 0}px, ${transform.y || 0}px) rotate(${transform.rotation || 0}deg) scale(${(transform.scale || 100) / 100}) scaleX(${transform.flipH ? -1 : 1}) scaleY(${transform.flipV ? -1 : 1})`,
    objectFit: ratio === 'original' || ratioMode === 'pad' ? 'contain' : 'cover'
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
  return <div className={`preview-frame pannable ${ratio === 'original' ? 'original' : ''} ${visible ? '' : 'media-surface-hidden'}`} style={{ aspectRatio: outputRatio }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <video
      ref={controller.videoRef} data-mount-id={mountId} preload="auto" style={style}
      onLoadedMetadata={controller.onLoadedMetadata} onLoadedData={controller.onLoadedData}
      onCanPlay={controller.onCanPlay} onSeeked={controller.onSeeked}
      onTimeUpdate={controller.onTimeUpdate} onPlay={controller.onPlay}
      onPause={controller.onPause} onEnded={controller.onPause} onError={controller.onError}
    />
    <div className="export-boundary"/>
  </div>
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
  if (!clip) return <div className="precision-scrubber disabled"/>
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

function TimelineClip({ clip, active, dragging, onSelect, onRemove, onDragStart, onDragEnter, onDragEnd, onRetry }) {
  const changeTransition = patch => window.dispatchEvent(new CustomEvent('cutflow-transition', { detail: { id: clip.id, patch } }))
  const clipPeaks = useMemo(() => {
    if (clip.mediaType !== 'audio' || !clip.visual?.length || !clip.duration) return clip.visual
    const start = Math.floor(clip.start / clip.duration * clip.visual.length)
    const end = Math.ceil(clip.end / clip.duration * clip.visual.length)
    return clip.visual.slice(start, Math.max(start + 1, end))
  }, [clip])
  return <div
    draggable className={`clip ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${clip.mediaType}`}
    style={{ width: Math.max(190, Math.min(350, (clip.end - clip.start) * 9)), viewTransitionName: `clip-${clip.id.replaceAll('-', '')}` }}
    onClick={event => { event.stopPropagation(); onSelect() }}
    onDragStart={onDragStart} onDragEnter={onDragEnter} onDragOver={event => event.preventDefault()} onDragEnd={onDragEnd}
  >
    <div className="clip-top"><GripVertical/><b>{clip.name}</b><span>{fmt(clip.end - clip.start)}</span></div>
    <div className="thumb">{clip.mediaType === 'video'
      ? clip.visual ? <img src={clip.visual}/> : clip.visualError ? <div className="thumbnail-error" onClick={event => { event.stopPropagation(); onRetry() }}>提取失败<br/>点击重试</div> : <div className="thumb-loading"><Video/></div>
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

function ExportPanelV2({ settings, setSettings, current, updateCurrent, updateTransform, resetTransform, applyLut, timelines, exporting, progress, doExport }) {
  const set = patch => setSettings({ ...settings, ...patch })
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
  if (!hasMedia) return <aside><div className="settings-empty"><Settings2/><h2>暂无设置</h2><p>拖入视频或音频后显示对应选项</p></div></aside>
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
        <div className="seg">{[['original', '原始'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']].map(([value, label]) => <button key={value} className={settings.ratio === value ? 'on' : ''} onClick={() => set({ ratio: value })}>{label}</button>)}</div>
        {settings.ratio !== 'original' && <div className="ratio-mode"><button className={settings.ratioMode === 'pad' ? 'on' : ''} onClick={() => set({ ratioMode: 'pad' })}>黑边填充</button><button className={settings.ratioMode === 'crop' ? 'on' : ''} onClick={() => set({ ratioMode: 'crop' })}>缩放填充</button></div>}
      </Field>
      <Field label="LUT">
        <div className="setting-scope"><button className={settings.lutScope === 'selected' ? 'on' : ''} onClick={() => set({ lutScope: 'selected' })}>应用选中片段</button><button className={settings.lutScope === 'all' ? 'on' : ''} onClick={() => set({ lutScope: 'all' })}>应用所有片段</button></div>
        <div className="lut-row"><select value={selectedLut.preset} onChange={event => applyLut({ preset: event.target.value, path: '', name: event.target.selectedOptions[0].text })}><option value="none">无</option><option value="sony-slog3">Sony S-Log3 / S-Gamut3.Cine → Rec.709</option><option value="sony-slog2">Sony S-Log2 / S-Gamut → Rec.709</option><option value="panasonic-vlog">Panasonic V-Log / V-Gamut → V-709</option>{selectedLut.preset === 'custom' && <option value="custom">自定义 LUT</option>}</select><button className="lut-file" onClick={chooseCustomLut}>选择 .cube</button></div>
        {selectedLut.preset === 'custom' && <div className="lut-name">{selectedLut.name || selectedLut.path}</div>}
      </Field>
      <div className="setting-scope"><button className={settings.transformScope === 'selected' ? 'on' : ''} onClick={() => set({ transformScope: 'selected' })}>缩放旋转：选中片段</button><button className={settings.transformScope === 'all' ? 'on' : ''} onClick={() => set({ transformScope: 'all' })}>缩放旋转：所有片段</button></div>
      <Field label="当前片段缩放" hint={`${transform.scale}%`}>
        <input disabled={!current || current.mediaType !== 'video'} type="range" min="50" max="300" step="5" value={transform.scale} onChange={event => updateTransform({ scale: +event.target.value })}/>
      </Field>
      <Field label="旋转、翻转与位置">
        <div className="transform-tools"><button disabled={!current || current.mediaType !== 'video'} onClick={() => updateTransform({ rotation: (transform.rotation + 90) % 360 })}><RotateCw/>旋转 90°</button><button disabled={!current || current.mediaType !== 'video'} className={transform.flipH ? 'on' : ''} onClick={() => updateTransform({ flipH: !transform.flipH })}><FlipHorizontal2/>水平翻转</button><button disabled={!current || current.mediaType !== 'video'} className={transform.flipV ? 'on' : ''} onClick={() => updateTransform({ flipV: !transform.flipV })}><FlipVertical2/>垂直翻转</button></div>
        <button className="transform-reset" disabled={!current || current.mediaType !== 'video'} onClick={resetTransform}><RotateCcw/>还原缩放与位置</button>
      </Field>
      <Field label="分辨率与帧率"><div className="audio-row"><select value={settings.resolution} onChange={event => set({ resolution: event.target.value })}><option value="original">跟随原视频</option><option value="2160p">4K</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option></select><select value={settings.fps} onChange={event => set({ fps: +event.target.value })}>{[24, 25, 30, 50, 60].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></div></Field>
      <Field label="视频编码"><div className="fixed"><b>H.264</b><span>兼容性最佳</span><CheckCircle2/></div></Field>
      <Field label="输出码率" hint={`${(settings.bitrate / 1000).toFixed(settings.bitrate % 1000 ? 1 : 0)} Mbps`}>
        <input type="range" min="1000" max="50000" step="500" value={settings.bitrate} onChange={event => set({ bitrate: +event.target.value })}/>
        <div className="bitrate-presets">{[3000, 5000, 8000, 12000, 20000, 35000, 50000].map(rate => <button key={rate} className={settings.bitrate === rate ? 'on' : ''} onClick={() => set({ bitrate: rate })}>{rate / 1000}M</button>)}</div>
      </Field>
      <button className="export" disabled={exporting} onClick={() => doExport('video')}><Download/>按时间轴分别导出</button>
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
      <button className="audio-export" disabled={exporting} onClick={() => doExport('audio')}><Music2/>声音导出</button>
    </section>}
    {exporting && <div className="progress"><div><span>正在处理…</span><b>{progress}%</b></div><i><em style={{ width: `${progress}%` }}/></i><button onClick={() => api.cancelExport()}>取消导出</button></div>}
  </aside>
}

createRoot(document.getElementById('root')).render(<App/>)
