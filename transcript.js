(function (root, factory) {
  const api = factory();
  root.YouTubeTranscript = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeText(text) {
    return String(text ?? "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cuesFromJson3(data) {
    return (data?.events ?? [])
      .filter((event) => Array.isArray(event.segs))
      .map((event) => ({
        startMs: Number(event.tStartMs ?? 0),
        text: normalizeText(event.segs.map((segment) => segment.utf8 ?? "").join(""))
      }))
      .filter((cue) => cue.text && cue.text !== "\n");
  }

  function removeRollingDuplicates(cues) {
    const result = [];

    for (const cue of cues) {
      const previous = result[result.length - 1];
      if (!previous) {
        result.push(cue);
        continue;
      }

      if (cue.text === previous.text) continue;
      if (cue.text.startsWith(previous.text)) {
        result[result.length - 1] = cue;
        continue;
      }

      result.push(cue);
    }

    return result;
  }

  function transcriptToText(cues) {
    return removeRollingDuplicates(cues)
      .map((cue) => cue.text.replace(/\n+/g, " "))
      .join("\n")
      .trim();
  }

  function safeFilename(title, languageCode) {
    const cleanTitle = normalizeText(title)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 120) || "youtube-subtitles";
    const cleanLanguage = normalizeText(languageCode).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${cleanTitle}${cleanLanguage ? ` [${cleanLanguage}]` : ""}.txt`;
  }

  function json3Url(baseUrl) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return url.toString();
  }

  function selectPreferredTrack(tracks, preferredLanguage, audioLanguage) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const baseLanguage = (value) => normalizeText(value)
      .toLowerCase()
      .replace(/_/g, "-")
      .split("-")[0];
    const preferred = baseLanguage(preferredLanguage);
    const audio = baseLanguage(audioLanguage);

    return tracks
      .map((track, index) => {
        const language = baseLanguage(track.languageCode);
        const automatic = track.kind === "asr";
        let score;
        if (preferred && language === preferred) score = automatic ? 1 : 0;
        else if (audio && language === audio) score = automatic ? 3 : 2;
        else if (language === "en") score = automatic ? 5 : 4;
        else score = automatic ? 7 : 6;
        return { track, index, score };
      })
      .sort((left, right) => left.score - right.score || left.index - right.index)[0].track;
  }

  function resolveWhisperLanguage(selection, detectedLanguage, text = "") {
    const supported = new Set([
      "ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "pt", "ru", "vi", "zh"
    ]);
    const normalizeCode = (value) => normalizeText(value)
      .toLowerCase()
      .replace(/_/g, "-")
      .split("-")[0];

    const selected = normalizeCode(selection);
    if (selection !== "auto" && supported.has(selected)) return selected;

    const detected = normalizeCode(detectedLanguage);
    if (supported.has(detected)) return detected;
    if (/[぀-ヿ]/u.test(text)) return "ja";
    if (/[가-힯]/u.test(text)) return "ko";
    if (/[一-鿿]/u.test(text)) return "zh";
    if (/[Ѐ-ӿ]/u.test(text)) return "ru";
    if (/[؀-ۿ]/u.test(text)) return "ar";
    if (/[ऀ-ॿ]/u.test(text)) return "hi";
    return "en";
  }

  return {
    cuesFromJson3,
    json3Url,
    normalizeText,
    removeRollingDuplicates,
    resolveWhisperLanguage,
    safeFilename,
    selectPreferredTrack,
    transcriptToText
  };
});
