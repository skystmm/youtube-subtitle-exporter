const test = require('node:test');
const assert = require('node:assert/strict');
const { getVideoPage } = require('../video-site.js');

test('recognizes Xiaohongshu detail pages and retains signed query parameters', () => {
  for (const path of ['/explore/', '/discovery/item/']) {
    const url = `https://www.xiaohongshu.com${path}67abc123?xsec_token=signed&xsec_source=pc_feed`;
    assert.deepEqual(getVideoPage(url), { site: 'xiaohongshu', videoId: '67abc123', url });
  }
});

test('recognizes the selected note in a Xiaohongshu feed modal', () => {
  const url = 'https://www.xiaohongshu.com/explore?noteId=67abc123&xsec_token=signed';
  assert.deepEqual(getVideoPage(url), { site: 'xiaohongshu', videoId: '67abc123', url: 'https://www.xiaohongshu.com/explore/67abc123?noteId=67abc123&xsec_token=signed' });
});

test('keeps YouTube working and rejects other sites and non-note pages', () => {
  assert.equal(getVideoPage('https://www.youtube.com/watch?v=abc').videoId, 'abc');
  for (const url of ['https://www.xiaohongshu.com/explore', 'https://example.com/explore/abc', 'https://www.xiaohongshu.com/user/profile/abc']) {
    assert.equal(getVideoPage(url), null);
  }
});
