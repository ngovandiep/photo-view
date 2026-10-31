'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

let worker;
let queue = Promise.resolve();

function convertInWorker(buffer) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'photo-preview-worker.cjs'));
      const created = worker;
      created.once('exit', () => { if (worker === created) worker = undefined; });
    }
    const active = worker;
    active.ref();
    const cleanup = () => {
      clearTimeout(timer);
      active.removeListener('message', onMessage);
      active.removeListener('error', onError);
      active.removeListener('exit', onExit);
      active.unref();
    };
    const onMessage = result => {
      cleanup();
      if (result.error) reject(new Error(result.error));
      else resolve(result.bytes);
    };
    const onError = error => {
      cleanup();
      if (worker === active) worker = undefined;
      reject(error);
    };
    const onExit = code => onError(new Error(`HEIC preview worker exited (${code})`));
    const timer = setTimeout(() => {
      onError(new Error('HEIC preview conversion timed out'));
      active.terminate();
    }, 60000);
    active.once('message', onMessage);
    active.once('error', onError);
    active.once('exit', onExit);
    const bytes = Uint8Array.from(buffer);
    active.postMessage(bytes, [bytes.buffer]);
  });
}

async function convertHeicPreview(buffer, convert) {
  if (!convert) {
    const result = queue.then(() => convertInWorker(buffer));
    // Keep subsequent jobs runnable; the caller still receives this job's rejection.
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  const jpeg = await convert({ buffer, format: 'JPEG', quality: 0.85 });
  return new Uint8Array(jpeg);
}

module.exports = { convertHeicPreview };
