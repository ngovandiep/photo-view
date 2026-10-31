'use strict';

const { parentPort } = require('node:worker_threads');
const convert = require('heic-convert');

parentPort.on('message', async bytes => {
  try {
    const jpeg = await convert({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), format: 'JPEG', quality: 0.85 });
    const result = Uint8Array.from(jpeg);
    parentPort.postMessage({ bytes: result }, [result.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
