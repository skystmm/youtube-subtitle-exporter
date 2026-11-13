const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Xiaohongshu toolbar action passes signed URL and language to existing offscreen transcription', async () => {
  const sent = [];
  let onClick;
  const metadata = {
    url: 'https://www.xiaohongshu.com/explore/67abc123?xsec_token=signed',
    title: '视频笔记', language: 'zh'
  };
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const context = vm.createContext({
    URL, setTimeout, AbortSignal,
    fetch: async () => ({ ok: true }),
    chrome: {
      runtime: {
        id: 'a'.repeat(32),
        getURL: value => `chrome-extension://test/${value}`,
        getContexts: async () => [{}],
        onMessage: { addListener() {} },
        sendMessage: async message => { sent.push(message); return { ok: true }; }
      },
      tabs: {
        sendMessage: async (_id, message) => {
          if (message.type === 'REQUEST_WHISPER_SETTINGS') return { metadata };
          if (message.type === 'WHISPER_FAST_STARTED') resolveDone();
        }
      },
      action: { onClicked: { addListener(fn) { onClick = fn; } } }
    }
  });
  context.importScripts = (...files) => files.forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../service-worker.js'), 'utf8'), context);
  onClick({ id: 42, url: metadata.url });
  await done;
  const request = sent.find(message => message.type === 'START_FAST_TRANSCRIPTION');
  assert.equal(request.tabId, 42);
  assert.equal(request.metadata.url, metadata.url);
  assert.equal(request.metadata.language, 'zh');
  assert.equal(request.metadata.transcriptionMode, 'accurate');
});
