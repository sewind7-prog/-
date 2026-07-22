const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async function runSmokeSuite({ app, mainWindow, fs, path, probeMediaRange, inspectMedia }) {
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
  const fixtures = ['test-h264.mp4', 'test-camera.mov', 'test-camera.mts', 'test-tone.mp3', 'test-tone.wav', 'test-audio-cover.m4a'].map(name => path.join(fixtureDir, name))
  const imageFixtures = ['test-image-a.jpg', 'test-image-b.png', 'test-image-c.webp'].map(name => path.join(fixtureDir, name))
  fixtures.forEach(file => {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 0) throw new Error(`测试文件无效：${file}`)
  })
  imageFixtures.forEach(file => {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 0) throw new Error(`测试图片无效：${file}`)
  })

  await until('Boolean(window.__cutflowTest)', 8000, '测试接口')
  const importStarted = Date.now()
  await evaluate(`window.__cutflowTest.importPaths(${JSON.stringify(fixtures)})`)
  const placeholders = await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0]?.clips.length === 6 ? s : null })()`, 2000, '占位片段立即显示')
  const importVisibleMs = Date.now() - importStarted
  const placeholderFeedback = placeholders.timelines[0].clips.some(clip => clip.pendingProbe)
  const noEagerVisualAnalysis = placeholders.timelines[0].clips.filter(clip => clip.visualReady || clip.visualLoading).length <= 1
  const imported = await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0]?.clips.length === 6 && s.timelines[0].clips.every(c => !c.pendingProbe && !c.probeError && c.duration > 0) ? s : null })()`, 90000, '六种媒体后台探测')
  const clips = imported.timelines[0].clips
  const results = { formats: {}, operations: {}, performance: { importVisibleMs } }
  results.operations.placeholderFeedback = placeholderFeedback
  results.operations.noEagerVisualAnalysis = noEagerVisualAnalysis
  results.operations.defaultRatio16x9 = imported.settings.ratio === '16:9'
  results.operations.defaultBitrate6M = imported.settings.bitrate === 6000
  results.operations.audioCoverClassifiedAsAudio = clips.find(clip => clip.path.toLowerCase().endsWith('.m4a'))?.mediaType === 'audio'
  results.operations.multiImportDefaultsToOneTimeline = imported.timelines.length === 1
    && imported.timelines[0].clips.length === fixtures.length
    && !await evaluate("Boolean(document.querySelector('.import-choice-overlay'))")
  const timelineOutputName = await evaluate(`window.__cutflowTest.outputName(${JSON.stringify(imported.timelines[0].id)}, 'timeline')`)
  const firstClipOutputName = await evaluate(`window.__cutflowTest.outputName(${JSON.stringify(imported.timelines[0].id)}, 'firstClip')`)
  results.operations.filenameByTimeline = timelineOutputName === imported.timelines[0].name
  results.operations.filenameByFirstClip = firstClipOutputName === path.basename(clips[0].name, path.extname(clips[0].name))
  const videoClipJobs = await evaluate("window.__cutflowTest.exportJobs('video', 'clip')")
  const audioClipJobs = await evaluate("window.__cutflowTest.exportJobs('audio', 'clip')")
  const expectedVideoNames = clips.filter(clip => clip.mediaType === 'video').map(clip => path.basename(clip.name, path.extname(clip.name)))
  const expectedAudioNames = clips.filter(clip => clip.mediaType === 'audio').map(clip => path.basename(clip.name, path.extname(clip.name)))
  results.operations.videoPerClipExportNames = expectedVideoNames.every(name => videoClipJobs.some(job => job.name === name && job.clipCount === 1))
  results.operations.audioPerClipExportNames = expectedAudioNames.every(name => audioClipJobs.some(job => job.name === name && job.clipCount === 1))
  results.operations.wholeTimelineExportDefaults = imported.settings.videoExportUnit === 'timeline' && imported.settings.audioExportUnit === 'timeline'
  const firstVisibleVideo = clips.find(clip => clip.mediaType === 'video')
  const automaticThumbnail = await until(`(() => { const s=window.__cutflowTest.state(); const clip=s.timelines[0].clips.find(item=>item.id===${JSON.stringify(firstVisibleVideo.id)}); return s.selected!==clip.id&&clip?.visualReady ? s : null })()`, 30000, 'visible unselected thumbnail')
  results.operations.visibleThumbnailWithoutClick = automaticThumbnail.selected !== firstVisibleVideo.id
  const defaultClipWidth = await evaluate('window.__cutflowTest.clipWidth(10)')
  const longClipWidth = await evaluate('window.__cutflowTest.clipWidth(120)')
  results.operations.timelineClipRatioAndCap = Math.abs(defaultClipWidth / 104 - 16 / 9) < 0.02 && longClipWidth <= defaultClipWidth * 1.5

  for (const clip of clips) {
    await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(clip.id)}, ${JSON.stringify(imported.timelines[0].id)})`)
    const state = await until(`(() => { const s=window.__cutflowTest.state(); const e=${JSON.stringify(clip.mediaType)}==='video'?s.video:s.audio; const c=s.timelines[0].clips.find(item=>item.id===${JSON.stringify(clip.id)}); return s.selected===${JSON.stringify(clip.id)} && s.previewStatus.state==='ready' && e.clipId===${JSON.stringify(clip.id)} && e.readyState>=2 && c?.visualReady ? s : null })()`, 30000, `预览与延迟缩略图 ${clip.name}`)
    const analyzedClip = state.timelines[0].clips.find(item => item.id === clip.id)
    results.formats[path.extname(clip.path).slice(1).toUpperCase()] = {
      proxied: analyzedClip.proxied,
      visualReady: analyzedClip.visualReady,
      visualPoints: analyzedClip.visualPoints,
      readyState: clip.mediaType === 'video' ? state.video.readyState : state.audio.readyState
    }
    if (clip.mediaType === 'video') {
      const entry = Math.min(clip.end - 0.3, clip.start + 0.35)
      const exit = Math.max(entry + 0.2, clip.end - 0.1)
      await evaluate(`window.__cutflowTest.markAt('in', ${entry}); window.__cutflowTest.markAt('out', ${exit}); window.__cutflowTest.scrubTo(${clip.start}); window.__cutflowTest.playFromIn()`)
      const startedAtIn = await until(`(() => { const s=window.__cutflowTest.state(); return s.playing && s.video.currentTime>=${entry - 0.04} && s.video.currentTime<${entry + 0.28} ? s : null })()`, 12000, `从入点播放 ${clip.name}`)
      results.formats[path.extname(clip.path).slice(1).toUpperCase()].startedAtIn = startedAtIn.video.currentTime >= entry - 0.04
      await evaluate('window.__cutflowTest.pause()')
    }
  }

  const movClip = clips.find(clip => clip.path.toLowerCase().endsWith('.mov'))
  await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(movClip.id)})`)
  const beforeTrim = await until(`(() => { const s=window.__cutflowTest.state(); const c=s.timelines[0].clips.find(item=>item.id===${JSON.stringify(movClip.id)}); return s.selected===${JSON.stringify(movClip.id)} && c?.visualReady ? c : null })()`, 10000, 'MOV 裁切前缩略图')
  await evaluate(`window.__cutflowTest.markAt('in', .4); window.__cutflowTest.markAt('out', ${Math.max(.7, movClip.end - .2)}); window.__cutflowTest.trim()`)
  const afterTrim = await until(`(() => { const s=window.__cutflowTest.state(); const c=s.timelines[0].clips.find(item=>item.id===${JSON.stringify(movClip.id)}); return c?.start===.4 && c.visualReady && c.visualTail!==${JSON.stringify(beforeTrim.visualTail)} ? c : null })()`, 20000, '裁切后重新提取首帧')
  results.operations.trimRefreshesThumbnail = afterTrim.visualTail !== beforeTrim.visualTail

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
  const returnedMp4 = await until(`(() => { const s=window.__cutflowTest.state(); return s.selected===${JSON.stringify(mp4.id)} && s.previewStatus.state==='ready' && s.video.readyState>=2 ? s : null })()`, 15000, '返回 MP4')
  const originalMp4Tail = returnedMp4.timelines[0].clips.find(clip => clip.id === mp4.id).visualTail

  await evaluate('window.__cutflowTest.scrubTo(.8); window.__cutflowTest.split()')
  const splitState = await until(`(() => { const s=window.__cutflowTest.state(); const selected=s.timelines[0].clips.find(c=>c.id===s.selected); return s.timelines[0].clips.length===7 && s.timelines[0].clips.filter(c=>c.path.toLowerCase().endsWith('.mp4')).length===2 && s.previewStatus.state==='ready' && selected?.visualReady && selected.visualTail!==${JSON.stringify(originalMp4Tail)} ? s : null })()`, 20000, '视频分割后新缩略图')
  results.operations.splitPreview = splitState.previewStatus.state === 'ready'
  results.operations.splitRefreshesThumbnail = splitState.timelines[0].clips.find(clip => clip.id === splitState.selected).visualTail !== originalMp4Tail
  await click('.clip.active > button')
  const deletedState = await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0].clips.length===6 ? s : null })()`, 5000, '删除片段')
  results.operations.deleteClip = deletedState.timelines[0].clips.length === 6
  const orderBefore = deletedState.timelines[0].clips.map(clip => clip.id)
  await evaluate(`document.querySelectorAll('.clip')[0].dispatchEvent(new DragEvent('dragstart',{bubbles:true}))`)
  await wait(120)
  await evaluate(`document.querySelectorAll('.clip')[2].dispatchEvent(new DragEvent('dragenter',{bubbles:true})); document.querySelectorAll('.clip')[0].dispatchEvent(new DragEvent('dragend',{bubbles:true}))`)
  const reorderedState = await until(`(() => { const ids=window.__cutflowTest.state().timelines[0].clips.map(c=>c.id); return ids[2]===${JSON.stringify(orderBefore[0])} ? window.__cutflowTest.state() : null })()`, 5000, '拖动排序')
  results.operations.reorderClips = reorderedState.timelines[0].clips[2].id === orderBefore[0]

  const videoOutput = path.join(outputDir, 'smoke-video.mp4')
  const videoWithoutLut = path.join(outputDir, 'smoke-video-no-lut.mp4')
  const movOutput = path.join(outputDir, 'smoke-video.mov')
  const alphaMovOutput = path.join(outputDir, 'smoke-video-alpha.mov')
  const audioOutput = path.join(outputDir, 'smoke-audio.mp3')
  await evaluate(`window.__cutflowTest.selectClip(${JSON.stringify(mp4.id)}); window.__cutflowTest.setClipLut(${JSON.stringify(mp4.id)}, {preset:'none',path:'',name:'无'})`)
  await until(`(() => { const s=window.__cutflowTest.state(); return s.selected===${JSON.stringify(mp4.id)} && s.previewStatus.state==='ready' ? s : null })()`, 10000, 'LUT 测试前预览')
  const noLutExport = await evaluate(`window.__cutflowTest.exportClip(${JSON.stringify(mp4.id)}, ${JSON.stringify(videoWithoutLut)}, {videoFormat:'mp4',resolution:'480p',fps:25,bitrate:6000,normalizeAudio:false})`)
  if (!noLutExport?.ok) throw new Error(`无 LUT 对照导出失败：${noLutExport?.error}`)
  await evaluate(`window.__cutflowTest.setClipLut(${JSON.stringify(mp4.id)}, {preset:'sony-slog3',path:'',name:'Sony S-Log3'})`)
  await until(`(() => { const s=window.__cutflowTest.state(); return s.timelines[0].clips.find(c=>c.id===${JSON.stringify(mp4.id)})?.lut?.preset==='sony-slog3' && s.lutPreview==='sony-slog3' ? s : null })()`, 10000, 'Sony S-Log3 实时预览')
  results.operations.lutPreviewActive = !(await evaluate('window.__cutflowTest.state().lutPreviewError'))
  const videoExport = await evaluate(`window.__cutflowTest.exportClip(${JSON.stringify(mp4.id)}, ${JSON.stringify(videoOutput)}, {videoFormat:'mp4',resolution:'480p',fps:25,bitrate:6000,normalizeAudio:false})`)
  if (!videoExport?.ok) throw new Error(`视频导出失败：${videoExport?.error}`)
  results.operations.builtInLutExport = Buffer.compare(fs.readFileSync(videoWithoutLut), fs.readFileSync(videoOutput)) !== 0
  await evaluate('window.__cutflowTest.clearProgressHistory()')
  const movExport = await evaluate(`window.__cutflowTest.exportClip(${JSON.stringify(mp4.id)}, ${JSON.stringify(movOutput)}, {videoFormat:'mov',resolution:'480p',fps:25,normalizeAudio:false})`)
  if (!movExport?.ok) throw new Error(`ProRes MOV 导出失败：${movExport?.error}`)
  const progressState = await evaluate('window.__cutflowTest.state()')
  results.operations.singleOverallProgress = progressState.progressHistory.length > 2 && progressState.progressHistory.every((value, index, values) => index === 0 || value >= values[index - 1]) && progressState.progressHistory.at(-1) === 100
  const alphaMovExport = await evaluate(`window.__cutflowTest.exportClip(${JSON.stringify(mp4.id)}, ${JSON.stringify(alphaMovOutput)}, {videoFormat:'mov-alpha',resolution:'480p',fps:25,normalizeAudio:false})`)
  if (!alphaMovExport?.ok) throw new Error(`透明通道 MOV 导出失败：${alphaMovExport?.error}`)
  const movInfo = await inspectMedia(movOutput)
  const alphaMovInfo = await inspectMedia(alphaMovOutput)
  results.operations.movProRes = movInfo.codec === 'prores'
  results.operations.movAlphaChannel = alphaMovInfo.codec === 'prores' && alphaMovInfo.pixelFormat.startsWith('yuva')
  const audioExport = await evaluate(`window.__cutflowTest.exportActive(${JSON.stringify(audioOutput)}, 'audio', {audioFormat:'mp3',audioBitrate:128,normalizeAudio:true,loudnessTarget:-16})`)
  if (!audioExport?.ok) throw new Error(`音频导出失败：${audioExport?.error}`)
  results.exports = { videoBytes: fs.statSync(videoOutput).size, movBytes: fs.statSync(movOutput).size, alphaMovBytes: fs.statSync(alphaMovOutput).size, audioBytes: fs.statSync(audioOutput).size }

  await evaluate(`window.__cutflowTest.importImages(${JSON.stringify(imageFixtures)})`)
  const imageState = await until(`(() => { const s=window.__cutflowTest.state(); return s.workspaceMode==='image' && s.images.length===3 && s.images.every(image=>image.loaded&&image.width>0&&image.height>0) ? s : null })()`, 15000, '图片文件夹与真实缩略图')
  results.operations.imageFolderMode = Boolean(await evaluate("document.querySelector('.image-folder-shell') && !document.querySelector('.new-timeline-drop')"))
  results.operations.imageOnlySettings = await evaluate("document.querySelectorAll('.settings-group').length===1 && Boolean(document.querySelector('.image-settings-group')) && !document.querySelector('.video-settings-group')")
  results.operations.imageFullPreview = await evaluate("(() => { const image=document.querySelector('.image-preview-frame img'), viewer=document.querySelector('.viewer'); if(!image||!viewer||!image.complete||!image.naturalWidth)return false; const a=image.getBoundingClientRect(),b=viewer.getBoundingClientRect(); return a.width>0&&a.height>0&&a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1 })()")
  results.operations.imagePreviewFixed = await evaluate("(() => { const workspace=document.querySelector('.image-workspace'),viewer=document.querySelector('.viewer'),grid=document.querySelector('.image-folder-grid'); const before=viewer.getBoundingClientRect().top; grid.scrollTop=grid.scrollHeight; const after=viewer.getBoundingClientRect().top; return getComputedStyle(workspace).overflowY==='hidden'&&Math.abs(before-after)<1 })()")
  results.operations.imageOriginalResolutionShown = await evaluate("(() => { const s=window.__cutflowTest.state(),current=s.images.find(image=>image.id===s.selectedImageId),inputs=[...document.querySelectorAll('.image-resolution-row input')].map(input=>+input.value); return inputs[0]===current.width&&inputs[1]===current.height })()")
  await evaluate("(() => { const cards=[...document.querySelectorAll('.image-card')]; cards[0].dispatchEvent(new MouseEvent('click',{bubbles:true})); cards[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); })()")
  const ctrlSelection = await until("(() => { const s=window.__cutflowTest.state(); return s.selectedImageIds.length===2 ? s : null })()", 3000, 'image ctrl multi-select')
  await evaluate("document.querySelectorAll('.image-card')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))")
  const shiftSelection = await until("(() => { const s=window.__cutflowTest.state(); return s.selectedImageIds.length===2&&s.selectedImageId===s.images[2].id ? s : null })()", 3000, 'image shift range select')
  results.operations.imageMultiSelection = ctrlSelection.selectedImageIds.length === 2 && shiftSelection.selectedImageIds.includes(shiftSelection.images[1].id) && shiftSelection.selectedImageIds.includes(shiftSelection.images[2].id)
  results.operations.imageMarqueeSelection = await evaluate("Boolean(document.querySelector('.image-folder-grid')) && getComputedStyle(document.querySelector('.image-folder-grid')).position==='relative'")
  const imageJobs = await evaluate(`window.__cutflowTest.imageJobs(${JSON.stringify(outputDir)}, 'png')`)
  results.operations.imageOriginalNames = imageFixtures.every(file => imageJobs.some(job => job.name === path.basename(file, path.extname(file))))
  await evaluate("window.__cutflowTest.setImageTransform({scale:125,rotation:90})")
  const transformedImage = await until("(() => { const s=window.__cutflowTest.state(); const image=s.images.find(item=>item.id===s.selectedImageId); return image?.transform?.scale===125&&image.transform.rotation===90 ? image : null })()", 3000, '图片缩放旋转')
  results.operations.imageScaleRotate = transformedImage.transform.scale === 125 && transformedImage.transform.rotation === 90
  await evaluate("window.__cutflowTest.setImageSettings({imageTransformScope:'all'})")
  await until("window.__cutflowTest.state().settings.imageTransformScope==='all'", 3000, '图片全部应用范围')
  await evaluate("window.__cutflowTest.setImageTransform({scale:110,rotation:37})")
  const allTransformed = await until("(() => { const s=window.__cutflowTest.state(); return s.images.every(image=>image.transform.scale===110&&image.transform.rotation===37) ? s : null })()", 3000, '任意角度应用全部图片')
  results.operations.imageArbitraryRotationAll = allTransformed.images.every(image => image.transform.rotation === 37)
  await evaluate("window.__cutflowTest.setImageSettings({imageTransformScope:'selected'})")
  await until("window.__cutflowTest.state().settings.imageTransformScope==='selected'", 3000, '图片选中应用范围')
  await evaluate("window.__cutflowTest.beginImageCrop('1:1')")
  await until("(() => { const s=window.__cutflowTest.state(); return s.imageCropEditing&&s.imageCropRatio==='1:1'&&document.querySelector('.image-crop-selection') ? s : null })()", 3000, '预览窗口比例裁切')
  await evaluate("document.querySelector('.image-crop-actions .apply').click()")
  const croppedImage = await until("(() => { const s=window.__cutflowTest.state(); const image=s.images.find(item=>item.id===s.selectedImageId); return !s.imageCropEditing&&image?.crop ? image : null })()", 3000, '应用图片裁切')
  const croppedCanvases = await until("(() => { const preview=document.querySelector('.image-preview-cropped[data-crop-applied=\"true\"]'),thumb=document.querySelector('.image-card.active .image-card-cropped-thumb[data-crop-applied=\"true\"]'); return preview?.width>0&&preview?.height>0&&thumb?.width>0&&thumb?.height>0 ? {preview:[preview.width,preview.height],thumb:[thumb.width,thumb.height]} : null })()", 5000, 'cropped preview and thumbnail')
  results.operations.imagePreviewCropApply = croppedImage.crop.width > 0 && croppedImage.crop.height > 0 && Boolean(croppedCanvases)
  results.operations.imageLowResolutionPresets = await evaluate("(() => { const values=[...document.querySelector('.image-resolution-preset').options].map(option=>option.value); return ['1024x768','854x480','640x480','320x240'].every(value=>values.includes(value)) })()")
  results.operations.imageResolutionAscending = await evaluate("[...document.querySelector('.image-resolution-preset').options].map(option=>option.value).filter(value=>value!=='original'&&value!=='custom').join(',')==='320x240,640x480,854x480,1024x768,1280x720,1080x1080,1080x1350,1920x1080,2560x1440,3840x2160'")
  results.operations.imageSizeOptions = await evaluate("(() => { const slider=document.querySelector('.image-size-slider>input[type=range]'),positions=[...document.querySelectorAll('.image-size-marks button')].map(button=>button.style.left); return +slider?.max===4&&+slider?.step===.05&&positions.join(',')==='0%,25%,50%,75%,100%' })()")
  await evaluate("(() => { const slider=document.querySelector('.image-size-slider>input[type=range]'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(slider,'1.5'); slider.dispatchEvent(new Event('input',{bubbles:true})) })()")
  const freeSize = await until("(() => { const value=window.__cutflowTest.state().settings.imageTargetSizeMb; return value>1&&value<2 ? value : null })()", 3000, 'free image size slider')
  results.operations.imageSizeSliderFree = freeSize > 1 && freeSize < 2
  results.operations.settingsFontReadable = await evaluate("parseFloat(getComputedStyle(document.querySelector('aside .field-label label')).fontSize)>=13 && parseFloat(getComputedStyle(document.querySelector('aside select')).fontSize)>=12")
  await evaluate("window.__cutflowTest.setImageSettings({imageResolutionPreset:'custom',imageWidth:640,imageHeight:480,imageTargetSizeMb:1})")
  const manualRatio = await until("(() => { const s=window.__cutflowTest.state(),label=document.querySelector('.image-dimension-ratio b')?.textContent?.trim(); return s.settings.imageResolutionPreset==='custom'&&s.settings.imageWidth===640&&s.settings.imageHeight===480&&s.settings.imageTargetSizeMb===1&&label==='4:3' ? {state:s,label} : null })()", 3000, 'manual resolution ratio')
  results.operations.imageManualRatioLabel = manualRatio.label === '4:3'
  results.operations.imageResolutionAndSizePreset = manualRatio.state.settings.imageTargetSizeMb === 1
  const imageFormats = ['jpg', 'png', 'webp', 'tiff', 'bmp']
  results.exports.images = {}
  for (const format of imageFormats) {
    const directory = path.join(outputDir, `images-${format}`)
    const result = await evaluate(`window.__cutflowTest.exportImageBatch(${JSON.stringify(directory)}, {imageFormat:${JSON.stringify(format)},imageResolutionPreset:'custom',imageWidth:320,imageHeight:240,imageTargetSizeMb:0})`)
    if (!result?.ok) throw new Error(`图片 ${format} 批量导出失败：${result?.error}`)
    const outputs = imageFixtures.map(file => path.join(directory, `${path.basename(file, path.extname(file))}.${format}`))
    results.exports.images[format] = outputs.map(file => fs.statSync(file).size)
    results.operations[`imageFormat${format.toUpperCase()}`] = outputs.every(file => fs.existsSync(file) && fs.statSync(file).size > 0)
  }
  const resizedImage = path.join(outputDir, 'images-png', 'test-image-a.png')
  const resizedDimensions = await evaluate(`new Promise(resolve => { const image=new Image(); image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight}); image.onerror=()=>resolve(null); image.src=window.cutflow.mediaUrl(${JSON.stringify(resizedImage)}) })`)
  results.operations.imageManualResolution = resizedDimensions?.width === 320 && resizedDimensions?.height === 240
  const croppedDirectory = path.join(outputDir, 'images-cropped-original')
  const croppedExport = await evaluate(`window.__cutflowTest.exportImageBatch(${JSON.stringify(croppedDirectory)}, {imageFormat:'png',imageResolutionPreset:'original',imageWidth:0,imageHeight:0,imageTargetSizeMb:0})`)
  if (!croppedExport?.ok) throw new Error(`原始分辨率裁切导出失败：${croppedExport?.error}`)
  const selectedSource = imageFixtures.at(-1)
  const croppedOutput = path.join(croppedDirectory, `${path.basename(selectedSource, path.extname(selectedSource))}.png`)
  const croppedDimensions = await evaluate(`new Promise(resolve => { const image=new Image(); image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight}); image.onerror=()=>resolve(null); image.src=window.cutflow.mediaUrl(${JSON.stringify(croppedOutput)}) })`)
  results.operations.imageCropAffectsExport = croppedDimensions?.width === croppedDimensions?.height
  const sizedDirectory = path.join(outputDir, 'images-sized-jpg')
  const sizedExport = await evaluate(`window.__cutflowTest.exportImageBatch(${JSON.stringify(sizedDirectory)}, {imageFormat:'jpg',imageResolutionPreset:'original',imageWidth:0,imageHeight:0,imageTargetSizeMb:1})`)
  if (!sizedExport?.ok) throw new Error(`图片目标体积导出失败：${sizedExport?.error}`)
  const sizedJpg = path.join(sizedDirectory, 'test-image-a.jpg')
  results.operations.imageTargetFileSize = fs.statSync(sizedJpg).size > 0 && fs.statSync(sizedJpg).size <= 1.05 * 1024 * 1024

  const everyVideoStartsAtIn = Object.values(results.formats).filter(item => item.visualPoints === 0).every(item => item.startedAtIn)
  const everyImageFormat = imageFormats.every(format => results.operations[`imageFormat${format.toUpperCase()}`])
  if (!everyVideoStartsAtIn || !everyImageFormat || !results.operations.visibleThumbnailWithoutClick || !results.operations.timelineClipRatioAndCap || !results.operations.imageFolderMode || !results.operations.imageOnlySettings || !results.operations.imageFullPreview || !results.operations.imagePreviewFixed || !results.operations.imageOriginalResolutionShown || !results.operations.imageMultiSelection || !results.operations.imageMarqueeSelection || !results.operations.imageOriginalNames || !results.operations.imageScaleRotate || !results.operations.imageArbitraryRotationAll || !results.operations.imagePreviewCropApply || !results.operations.imageLowResolutionPresets || !results.operations.imageResolutionAscending || !results.operations.imageSizeOptions || !results.operations.imageSizeSliderFree || !results.operations.settingsFontReadable || !results.operations.imageManualRatioLabel || !results.operations.imageResolutionAndSizePreset || !results.operations.imageManualResolution || !results.operations.imageCropAffectsExport || !results.operations.imageTargetFileSize || !results.operations.audioCoverClassifiedAsAudio || !results.operations.multiImportDefaultsToOneTimeline || !results.operations.videoPerClipExportNames || !results.operations.audioPerClipExportNames || !results.operations.wholeTimelineExportDefaults || !results.operations.trimRefreshesThumbnail || !results.operations.splitRefreshesThumbnail || !results.operations.singleOverallProgress || !results.operations.defaultRatio16x9 || !results.operations.defaultBitrate6M || !results.operations.placeholderFeedback || !results.operations.noEagerVisualAnalysis || !results.operations.filenameByTimeline || !results.operations.filenameByFirstClip || !results.operations.stableMount || !results.operations.stableSourceAfterSeekAndTransform || !results.operations.seekTargetHeld || !results.operations.nativeRangeDrag || !results.operations.nativeInHandleDrag || !results.operations.nativeOutHandleDrag || !results.operations.intervalStartedAtIn || !results.operations.firstClipMarksIndependent || !results.operations.playheadMarkerVisible || !results.operations.stoppedAtOut || !results.operations.noReloadOnTransform || !results.operations.waveformClickSeek || !results.operations.waveformWheelZoom || !results.operations.range206 || !results.operations.deleteClip || !results.operations.reorderClips || !results.operations.lutPreviewActive || !results.operations.builtInLutExport || !results.operations.movProRes || !results.operations.movAlphaChannel) {
    throw new Error(`核心定位断言失败：${JSON.stringify(results.operations)}`)
  }
  const message = `CUTFLOW_SMOKE_RESULT=${JSON.stringify(results)}\n`
  process.stdout.write(message)
  if (process.env.CUTFLOW_SMOKE_LOG) fs.writeFileSync(process.env.CUTFLOW_SMOKE_LOG, message)
  app.exit(0)
}
