// 生成 512x512 蓝色 PNG 图标，用于 Tauri 图标生成
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const width = 512;
const height = 512;

// 每行: 1 字节 filter + width * 4 字节 RGBA
const rowSize = 1 + width * 4;
const rawData = Buffer.alloc(rowSize * height);
for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0; // filter: none
    for (let x = 0; x < width; x++) {
        const offset = y * rowSize + 1 + x * 4;
        // 深灰蓝（匹配 DG2 机器人配色）
        rawData[offset] = 0x12;
        rawData[offset + 1] = 0x14;
        rawData[offset + 2] = 0x1c;
        rawData[offset + 3] = 0xff;
    }
}

const compressed = zlib.deflateSync(rawData);
const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const crcTable = [];
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
        else c = c >>> 1;
    }
    crcTable[n] = c;
}
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([lengthBuf, typeBuf, data, crc]);
}

const png = Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0))
]);

const outPath = path.join(__dirname, 'source-icon.png');
fs.writeFileSync(outPath, png);
console.log('Created:', outPath, png.length, 'bytes');
