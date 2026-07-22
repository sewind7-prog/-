const { nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const source = nativeImage.createFromPath(path.join(root, 'assets', 'icon.png'))
if (source.isEmpty()) throw new Error('无法读取 assets/icon.png')

const images = [16, 24, 32, 48, 64, 128, 256].map(size => ({
  size,
  data: source.resize({ width: size, height: size, quality: 'best' }).toPNG()
}))
const headerSize = 6 + images.length * 16
let offset = headerSize
const header = Buffer.alloc(headerSize)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
images.forEach((image, index) => {
  const entry = 6 + index * 16
  header.writeUInt8(image.size === 256 ? 0 : image.size, entry)
  header.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1)
  header.writeUInt8(0, entry + 2)
  header.writeUInt8(0, entry + 3)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += image.data.length
})
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...images.map(image => image.data)]))
