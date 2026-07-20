const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async function runSmokeSuite({ app, mainWindow, fs, path, probeMediaRange }) {
  const evaluate = source => mainWindow.webContents.executeJavaScript(source, true)
  const pointOn = async (selector, ratio = 0.5) => {
    const rect = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? {x:r.x,y:r.y,width:r.width,height:r.height} : null })()`)
    if (!rect) throw new Error(`找不到测试控件：${selector}`)
    return { x: Math.round(rect.x + rect.width * ratio), y: Math.round(rect.y + rect.height / 2) }
  }
  const drag = async (selector, from, to) => {
    const start = await pointOn(selector, from)
    const end = await pointOn(selector, to)
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...start })
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 8; step++) {
      mainWindow.webContents.sendInputEvent({
        type: 'mouseMove', button: 'left',
        x: Math.round(start.x + (end.x - start.x) * step / 8),
        y: Math.round(start.y + (end.y - start.y) * step / 8)
      })
      await wait(18)
    }
    mainWindow.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 })
  }
  const click = async (selector, ratio = 0.5) => {
    const point = await pointOn(selector, ratio)
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    mainWindow.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const until = async (source, timeout = 30000, label = '条件') => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = await evaluate(source)
      if (value) return value
      await wait(80)
    }
    let snapshot = null
    try { snapshot = await evaluate('({state:window.__cutflowTest?.state?.(),geometry:window.__smokeGeometry})') } catch { /* page can be closing */ }
    throw new Error(`等待${label}超时\n${JSON.stringify(snapshot)}`)
  }
  const fixtureDir = process.env.CUTFLOW_SMOKE_MEDIA
  const outputDir = process.env.CUTFLOW_SMOKE_OUTPUT
  if (!fixtureDir || !outputDir) throw new Error('缺少测试素材或输出目录')
  const fixtures = ['test-h264.mp4', 'test-camera.mov', 'test-camera.mts', 'test-tone.mp3', 'test-tone.wav'].map(name => path.join(fixtureDir, name))
  fixtures.forEach(file => {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 0) throw new Error(`测试文件无效：${file}`)
  })

  await until('Boolean(window.__cutflowTest)', 8000, '测试接口')
  const importStarted = Date.now()
  await evaluate(`window.__cutflowTest.importPaths(${JSON.stringify(fixtures)})`)
  const importVisibleMs = Date.now() - importStarted
  const imported = await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0]?.clips.length === 5 && s.timelines[0].clips.every(c => c.visualReady) ? s : null })()`, 90000, '五种媒体分析')
  const clips = imported.timelines[0].clips
  const results = { formats: {}, operations: {}, performance: { importVisibleMs } }
  const timelineOutputName = await evaluate(`window.__cutflowTest.outputName(${JSON.stringify(imported.timelines[0].id)}, 'timeline')`)
  const firstClipOutputName = await evaluate(`window.__cutflowTest.outputName(${JSON.stringify(imported.timelines[0].id)}, 'firstClip')`)
  results.operations.filenameByTimeline = timelineOutputName === imported.timelines[0].name
  results.operations.filenameByFirstClip = firstClipOutputName === path.basename(clips[0].name, path.extname(clips[0].name))

  for (const clip of clips) {
    await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(clip.id)}, ${JSON.stringify(imported.timelines[0].id)})`)
    const state = await until(`(() => { const s=window.__cutflowTest.state(); const e=${JSON.stringify(clip.mediaType)}==='video'?s.video:s.audio; return s.selected===${JSON.stringify(clip.id)} && s.previewStatus.state==='ready' && e.clipId===${JSON.stringify(clip.id)} && e.readyState>=2 ? s : null })()`, 30000, `预览 ${clip.name}`)
    results.formats[path.extname(clip.path).slice(1).toUpperCase()] = {
      proxied: clip.proxied,
      visualReady: clip.visualReady,
      visualPoints: clip.visualPoints,
      readyState: clip.mediaType === 'video' ? state.video.readyState : state.audio.readyState
    }
  }

  const mp4 = clips.find(clip => clip.path.toLowerCase().endsWith('.mp4'))
  await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(mp4.id)})`)
  const before = await until(`(() => { const s=window.__cutflowTest.state(); return s.selected===${JSON.stringify(mp4.id)} && s.previewStatus.state==='ready' && s.video.clipId===${JSON.stringify(mp4.id)} && s.video.readyState>=2 ? s : null })()`, 20000, 'MP4 首帧')
  const rangeResult = await probeMediaRange(mp4.previewPath)
  if (rangeResult.status !== 206 || rangeResult.bytes !== 128 || !rangeResult.range) throw new Error(`媒体 Range 读取失败：${JSON.stringify(rangeResult)}`)
  const target = Math.min(mp4.end - 0.2, mp4.start + 1.15)
  await evaluate(`window.__cutflowTest.scrubTo(${target})`)
  const scrubbed = await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.video.currentTime-${target})<0.06 && Math.abs(s.time-${target})<0.06 ? s : null })()`, 5000, '视频任意定位')
  await drag('[data-role="progress-range"]', target / mp4.end, 0.72)
  const nativeScrubbed = await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.video.currentTime-${mp4.end * 0.72})<0.14 && !s.video.seeking && s.video.readyState>=2 ? s : null })()`, 5000, '原生进度条鼠标拖动')
  await evaluate(`window.__cutflowTest.markAt('in', 0.45)`)
  await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.marks.in-.45)<.01 && Math.abs(s.video.currentTime-.45)<.06 && !s.video.seeking ? s : null })()`, 5000, '入点定位')
  await evaluate(`window.__cutflowTest.markAt('out', 1.25)`)
  await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.marks.out-1.25)<.01 && Math.abs(s.video.currentTime-1.25)<.06 && !s.video.seeking ? s : null })()`, 5000, '出点定位')
  await drag('[data-role="in-range"]', 0.45 / mp4.end, 0.24)
  const nativeMarks = await until(`(() => { const s=window.__cutflowTest.state(); return s.marks.in>.5 && s.marks.in<.72 && !s.video.seeking ? s : null })()`, 5000, '入点手柄鼠标拖动')
  await drag('[data-role="out-range"]', 1.25 / mp4.end, 0.56)
  const nativeOut = await until(`(() => { const s=window.__cutflowTest.state(); return s.marks.out>1.26 && s.marks.out<1.5 && !s.video.seeking ? s : null })()`, 5000, '出点手柄鼠标拖动')
  await evaluate(`window.__cutflowTest.scrubTo(1.8)`)
  await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.video.currentTime-1.8)<.06 && !s.video.seeking && s.video.readyState>=2 ? s : null })()`, 5000, '播放前定位')
  await click('.controls > button')
  const playingState = await until(`(() => { const s=window.__cutflowTest.state(); return s.playing && Math.abs(s.video.currentTime-s.marks.in)<.2 && s.video.currentTime<${nativeOut.marks.out} ? s : null })()`, 5000, '区间播放从入点开始')
  const stopped = await until(`(() => { const s=window.__cutflowTest.state(); return !s.playing && Math.abs(s.video.currentTime-${nativeOut.marks.out})<.06 ? s : null })()`, 5000, '出点自动暂停')
  await evaluate(`window.__cutflowTest.transform({scale: 145, rotation: 90, flipH: true})`)
  const transformed = await until(`(() => { const s=window.__cutflowTest.state(); const c=s.timelines[0].clips.find(x=>x.id===${JSON.stringify(mp4.id)}); return c?.transform.scale===145 && c.transform.rotation===90 && c.transform.flipH ? s : null })()`, 3000, '片段变换')
  results.operations = {
    ...results.operations,
    stableMount: before.video.mountId === transformed.video.mountId,
    stableSourceAfterSeekAndTransform: before.video.src === transformed.video.src,
    seekTargetHeld: Math.abs(scrubbed.video.currentTime - target) < 0.06,
    nativeRangeDrag: Math.abs(nativeScrubbed.video.currentTime - mp4.end * 0.72) < 0.14,
    nativeInHandleDrag: nativeMarks.marks.in > 0.5,
    nativeOutHandleDrag: nativeOut.marks.out > 1.2,
    intervalStartedAtIn: Math.abs(playingState.video.currentTime - playingState.marks.in) < 0.2,
    firstClipMarksIndependent: Math.abs(nativeOut.marks.in - nativeMarks.marks.in) < 0.01 && nativeOut.marks.out > nativeMarks.marks.out,
    playheadMarkerVisible: Boolean(await evaluate("document.querySelector('.playhead-marker')")),
    stoppedAtOut: Math.abs(stopped.video.currentTime - nativeOut.marks.out) < 0.06,
    noReloadOnTransform: transformed.metrics.videoLoads === before.metrics.videoLoads,
    firstFrames: transformed.metrics.firstFrames,
    range206: rangeResult.status === 206
  }

  const mp3 = clips.find(clip => clip.path.toLowerCase().endsWith('.mp3'))
  await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(mp3.id)})`)
  await until(`(() => { const s=window.__cutflowTest.state(); return s.selected===${JSON.stringify(mp3.id)} && s.previewStatus.state==='ready' && s.audio.clipId===${JSON.stringify(mp3.id)} ? s : null })()`, 10000, 'MP3 波形预览')
  await evaluate(`window.__smokeGeometry=(() => { const box=document.querySelector('.audio-wave-scroll'), inner=document.querySelector('.audio-wave-inner'); const b=box.getBoundingClientRect(), i=inner.getBoundingClientRect(); return {box:{x:b.x,y:b.y,width:b.width,height:b.height,clientWidth:box.clientWidth,scrollWidth:box.scrollWidth,scrollLeft:box.scrollLeft},inner:{x:i.x,y:i.y,width:i.width,height:i.height}} })()`)
  await click('.audio-wave-scroll', 0.64)
  const waveformLocated = await until(`(() => { const s=window.__cutflowTest.state(); return Math.abs(s.audio.currentTime-${mp3.end * 0.64})<.14 ? s : null })()`, 5000, '点击音频波形定位')
  const wheelPoint = await pointOn('.audio-wave-scroll', 0.5)
  // Electron's sendInputEvent uses native Windows wheel direction (positive is wheel-up).
  mainWindow.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 120, canScroll: true })
  const waveformZoomed = await until(`(() => { const s=window.__cutflowTest.state(); return s.audioZoom>100 ? s : null })()`, 3000, '音频波形滚轮缩放')
  results.operations.waveformClickSeek = Math.abs(waveformLocated.audio.currentTime - mp3.end * 0.64) < 0.14
  results.operations.waveformWheelZoom = waveformZoomed.audioZoom > 100

  await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(mp4.id)})`)
  await until(`(() => { const s=window.__cutflowTest.state(); return s.selected===${JSON.stringify(mp4.id)} && s.previewStatus.state==='ready' && s.video.readyState>=2 ? s : null })()`, 15000, '返回 MP4')

  await evaluate('window.__cutflowTest.scrubTo(.8); window.__cutflowTest.split()')
  const splitState = await until(`(() => { const s=window.__cutflowTest.state(); const selected=s.timelines[0].clips.find(c=>c.id===s.selected); return s.timelines[0].clips.length===6 && s.timelines[0].clips.filter(c=>c.path.toLowerCase().endsWith('.mp4')).length===2 && s.previewStatus.state==='ready' && selected?.visualReady ? s : null })()`, 20000, '视频分割')
  results.operations.splitPreview = splitState.previewStatus.state === 'ready'
  await click('.clip.active > button')
  const deletedState = await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0].clips.length===5 ? s : null })()`, 5000, '删除片段')
  results.operations.deleteClip = deletedState.timelines[0].clips.length === 5
  const orderBefore = deletedState.timelines[0].clips.map(clip => clip.id)
  await evaluate(`document.querySelectorAll('.clip')[0].dispatchEvent(new DragEvent('dragstart',{bubbles:true}))`)
  await wait(120)
  await evaluate(`document.querySelectorAll('.clip')[2].dispatchEvent(new DragEvent('dragenter',{bubbles:true})); document.querySelectorAll('.clip')[0].dispatchEvent(new DragEvent('dragend',{bubbles:true}))`)
  const reorderedState = await until(`(() => { const ids=window.__cutflowTest.state().timelines[0].clips.map(c=>c.id); return ids[2]===${JSON.stringify(orderBefore[0])} ? window.__cutflowTest.state() : null })()`, 5000, '拖动排序')
  results.operations.reorderClips = reorderedState.timelines[0].clips[2].id === orderBefore[0]

  const videoOutput = path.join(outputDir, 'smoke-video.mp4')
  const audioOutput = path.join(outputDir, 'smoke-audio.mp3')
  await evaluate(`window.__cutflowTest.setClipLut(${JSON.stringify(mp4.id)}, {preset:'sony-slog3',path:'',name:'Sony S-Log3'})`)
  await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0].clips.find(c=>c.id===${JSON.stringify(mp4.id)})?.lut?.preset==='sony-slog3' ? s : null })()`, 3000, 'Sony S-Log3 LUT 设置')
  const videoExport = await evaluate(`window.__cutflowTest.exportActive(${JSON.stringify(videoOutput)}, 'video', {resolution:'480p',fps:25,bitrate:3000,normalizeAudio:false})`)
  if (!videoExport?.ok) throw new Error(`视频导出失败：${videoExport?.error}`)
  results.operations.builtInLutExport = true
  const audioExport = await evaluate(`window.__cutflowTest.exportActive(${JSON.stringify(audioOutput)}, 'audio', {audioFormat:'mp3',audioBitrate:128,normalizeAudio:true,loudnessTarget:-16})`)
  if (!audioExport?.ok) throw new Error(`音频导出失败：${audioExport?.error}`)
  results.exports = { videoBytes: fs.statSync(videoOutput).size, audioBytes: fs.statSync(audioOutput).size }

  if (!results.operations.filenameByTimeline || !results.operations.filenameByFirstClip || !results.operations.stableMount || !results.operations.stableSourceAfterSeekAndTransform || !results.operations.seekTargetHeld || !results.operations.nativeRangeDrag || !results.operations.nativeInHandleDrag || !results.operations.nativeOutHandleDrag || !results.operations.intervalStartedAtIn || !results.operations.firstClipMarksIndependent || !results.operations.playheadMarkerVisible || !results.operations.stoppedAtOut || !results.operations.noReloadOnTransform || !results.operations.waveformClickSeek || !results.operations.waveformWheelZoom || !results.operations.range206 || !results.operations.deleteClip || !results.operations.reorderClips || !results.operations.builtInLutExport) {
    throw new Error(`核心定位断言失败：${JSON.stringify(results.operations)}`)
  }
  const message = `CUTFLOW_SMOKE_RESULT=${JSON.stringify(results)}\n`
  process.stdout.write(message)
  if (process.env.CUTFLOW_SMOKE_LOG) fs.writeFileSync(process.env.CUTFLOW_SMOKE_LOG, message)
  app.exit(0)
}
