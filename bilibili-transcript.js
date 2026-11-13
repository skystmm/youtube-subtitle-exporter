(function (root, factory) {
  const api = factory();
  root.BilibiliTranscript = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeText(text) {
    return String(text ?? "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  }

  function extractBvid(pathname) {
    return String(pathname ?? "").match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] ?? null;
  }

  function cuesFromJson(data) {
    return (data?.body ?? [])
      .map((item) => ({
        startMs: Math.max(0, Number(item.from) * 1000),
        endMs: Math.max(0, Number(item.to) * 1000),
        text: normalizeText(item.content)
      }))
      .filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.text);
  }

  function normalizeSubtitleUrl(value) {
    if (!value) return "";
    if (value.startsWith("//")) return `https:${value}`;
    return new URL(value, "https://www.bilibili.com").toString();
  }

  function selectPage(videoData, pageNumber = 1) {
    const pages = Array.isArray(videoData?.pages) ? videoData.pages : [];
    return pages.find((page) => Number(page.page) === Number(pageNumber)) ?? pages[0] ?? null;
  }

  function normalizeTracks(data) {
    return (data?.subtitle?.subtitles ?? [])
      .map((track) => ({
        id: track.id,
        languageCode: normalizeText(track.lan),
        name: normalizeText(track.lan_doc || track.lan) || "字幕",
        url: normalizeSubtitleUrl(track.subtitle_url)
      }))
      .filter((track) => track.url);
  }

  function selectPreferredTrack(tracks, preferredLanguage) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const preferred = normalizeText(preferredLanguage).toLowerCase().replace(/_/g, "-").split("-")[0];
    return tracks.find((track) => track.languageCode.toLowerCase().split("-")[0] === preferred) ?? tracks[0];
  }

  function transcriptToText(cues) {
    return cues.map((cue) => cue.text).join("\n").trim();
  }

  function safeFilename(title, languageCode) {
    const cleanTitle = normalizeText(title)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 120) || "bilibili-subtitles";
    const cleanLanguage = normalizeText(languageCode).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${cleanTitle}${cleanLanguage ? ` [${cleanLanguage}]` : ""}.txt`;
  }

  return {
    cuesFromJson,
    extractBvid,
    normalizeSubtitleUrl,
    normalizeTracks,
    safeFilename,
    selectPage,
    selectPreferredTrack,
    transcriptToText
  };
});
