// `npm run icon`: packs the app's icon (public/icon-512.png, the stud) into assets/icon.ico, the
// sizes Windows asks for (16 to 256), each kept as PNG inside the .ico.
const { app, nativeImage } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(join(__dirname, '..', '..', 'public', 'icon-512.png'));
  if (source.isEmpty()) throw new Error('public/icon-512.png could not be read');
  const images = SIZES.map((size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const head = Buffer.alloc(6 + 16 * SIZES.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(SIZES.length, 4);
  let offset = head.length;
  SIZES.forEach((size, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
    head.writeUInt8(size === 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(images[i].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  mkdirSync(join(__dirname, '..', 'assets'), { recursive: true });
  writeFileSync(join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([head, ...images]));
  console.log(`assets/icon.ico: ${SIZES.join(', ')} px`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
