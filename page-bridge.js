(() => {
  const RESPONSE_EVENT = "yt-subtitle-exporter:tracks";
  const REQUEST_EVENT = "yt-subtitle-exporter:request-tracks";

  function getPlayerResponse() {
    const player = document.getElementById("movie_player");
    if (player && typeof player.getPlayerResponse === "function") {
      try {
        const response = player.getPlayerResponse();
        if (response) return response;
      } catch (_) {
        // Continue through the known YouTube response locations below.
      }
    }

    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    if (window.ytplayer?.config?.args?.raw_player_response) {
      return window.ytplayer.config.args.raw_player_response;
    }

    const embedded = window.ytplayer?.config?.args?.player_response;
    if (typeof embedded === "string") {
      try {
        return JSON.parse(embedded);
      } catch (_) {
        return undefined;
      }
    }

    return undefined;
  }

  document.addEventListener(REQUEST_EVENT, () => {
    const response = getPlayerResponse();
    const tracks =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          audioLanguage:
            response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage ??
            response?.streamingData?.adaptiveFormats?.find(
              (format) => format.audioTrack?.audioIsDefault
            )?.audioTrack?.id,
          tracks: tracks.map((track) => ({
            baseUrl: track.baseUrl,
            languageCode: track.languageCode,
            name: track.name?.simpleText ?? track.name?.runs?.map((run) => run.text).join("") ?? track.languageCode,
            kind: track.kind ?? "",
            isTranslatable: Boolean(track.isTranslatable)
          }))
        }
      })
    );
  });

})();
