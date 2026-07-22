const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const source = path.join(root, 'assets', 'icon.svg')
  const output = path.join(root, 'assets', 'icon.png')
  const window = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', webPreferences: { backgroundThrottling: false }
  })
  await window.loadURL(pathToFileURL(source).toString())
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(output, image.toPNG())
  window.destroy()
  app.quit()
}).catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  app.exit(1)
})
