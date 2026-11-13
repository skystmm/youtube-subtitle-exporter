(function (root, factory) {
  const api = factory();
  root.VideoSite = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function getVideoPage(value) {
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      return videoId ? { site: 'youtube', videoId, url: url.href } : null;
    }
    if (url.hostname !== 'www.xiaohongshu.com') return null;
    const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)\/?$/);
    const videoId = match?.[1] || (url.pathname === '/explore' ? url.searchParams.get('noteId') : null);
    if (!videoId || !/^[a-zA-Z0-9]+$/.test(videoId)) return null;
    if (!match) url.pathname = `/explore/${videoId}`;
    return { site: 'xiaohongshu', videoId, url: url.href };
  }
  return { getVideoPage };
});
