(() => {
  const REQUEST_EVENT = "yt-subtitle-exporter:request-tracks";
  const RESPONSE_EVENT = "yt-subtitle-exporter:tracks";
  let root;
  let trackRequest;
  let whisperSession;
  let fastWhisperRunning = false;
  let detectedAudioLanguage;
  const TRANSCRIPT_SEGMENT_SELECTOR =
    "ytd-transcript-segment-renderer, transcript-segment-view-model";

  function isVideoPage() {
    return location.pathname === "/watch" && new URLSearchParams(location.search).has("v");
  }

  function getTracks() {
    if (trackRequest) return trackRequest;
    trackRequest = new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(null), 3000);
      document.addEventListener(
        RESPONSE_EVENT,
        (event) => {
          window.clearTimeout(timeout);
          if (Array.isArray(event.detail)) {
            resolve({ tracks: event.detail, audioLanguage: undefined });
          } else {
            resolve({
              tracks: Array.isArray(event.detail?.tracks) ? event.detail.tracks : [],
              audioLanguage: event.detail?.audioLanguage
            });
          }
        },
        { once: true }
      );
      document.dispatchEvent(new CustomEvent(REQUEST_EVENT));
    }).finally(() => {
      trackRequest = null;
    });
    return trackRequest;
  }

  function readRenderedTranscript() {
    const firstSegment = document.querySelector(TRANSCRIPT_SEGMENT_SELECTOR);
    if (!firstSegment) return [];
    const scope =
      firstSegment.closest("ytd-engagement-panel-section-list-renderer") ?? document;

    return [...scope.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTOR)]
      .map((segment) => {
        const textNode = segment.matches("ytd-transcript-segment-renderer")
          ? segment.querySelector(".segment-text")
          : segment.querySelector(
              ".ytAttributedStringHost, [class*='AttributedString']"
            );
        return {
          startMs: 0,
          text: YouTubeTranscript.normalizeText(textNode?.textContent ?? "")
        };
      })
      .filter((cue) => cue.text);
  }

  function waitForRenderedTranscript(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const existing = readRenderedTranscript();
      if (existing.length) {
        resolve(existing);
        return;
      }

      const observer = new MutationObserver(() => {
        const cues = readRenderedTranscript();
        if (!cues.length) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        resolve(cues);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("YouTube 原生文字稿加载超时"));
      }, timeoutMs);
    });
  }

  async function getTranscriptFallback() {
    const existing = readRenderedTranscript();
    if (existing.length) return existing;

    const expandButton = document.querySelector(
      "ytd-watch-metadata ytd-text-inline-expander #expand"
    );
    expandButton?.click();

    await new Promise((resolve) => window.setTimeout(resolve, 150));
    const transcriptButton = document.querySelector(
      "ytd-video-description-transcript-section-renderer button, " +
      "ytd-video-description-transcript-section-renderer #button"
    );
    if (!transcriptButton) {
      throw new Error("找不到 YouTube 的“内容转文字”按钮");
    }

    transcriptButton.click();
    return waitForRenderedTranscript();
  }

  function setStatus(message, isError = false) {
    const status = root?.querySelector(".ytse-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.error = String(isError);
  }

  function downloadText(text, filename) {
    const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remaining}`;
  }

  function getWhisperMetadata() {
    const selection = root?.querySelector(".ytse-language")?.value || "auto";
    return {
      videoId: new URLSearchParams(location.search).get("v"),
      title: document.title.replace(/ - YouTube$/, ""),
      url: `https://www.youtube.com/watch?v=${new URLSearchParams(location.search).get("v")}`,
      language: YouTubeTranscript.resolveWhisperLanguage(
        selection,
        detectedAudioLanguage,
        document.title
      ),
      languageSelection: selection
    };
  }

  function resetWhisperControls() {
    fastWhisperRunning = false;
    const accurateButton = root?.querySelector(".ytse-accurate-whisper");
    const fastButton = root?.querySelector(".ytse-fast-whisper");
    const captureButton = root?.querySelector(".ytse-whisper");
    const cancelButton = root?.querySelector(".ytse-whisper-cancel");
    if (accurateButton) {
      accurateButton.disabled = false;
      accurateButton.textContent = "高准确率转写（推荐）";
    }
    if (fastButton) {
      fastButton.disabled = false;
      fastButton.textContent = "较快转写（浏览器 Base）";
    }
    if (captureButton) {
      captureButton.disabled = false;
      captureButton.textContent = "备用：播放录制模式";
    }
    if (cancelButton) cancelButton.hidden = true;
  }

  function restoreVideo() {
    const session = whisperSession;
    if (session) {
      const { video } = session;
      video.removeEventListener("ended", finishWhisperCapture);
      video.removeEventListener("timeupdate", updateWhisperProgress);
      video.playbackRate = session.playbackRate;
      video.currentTime = Math.min(session.currentTime, video.duration || session.currentTime);
      if (session.wasPaused) {
        video.pause();
      } else {
        video.play().catch(() => {});
      }
      whisperSession = undefined;
    }
    resetWhisperControls();
  }

  function updateWhisperProgress() {
    const video = whisperSession?.video;
    if (!video) return;
    setStatus(`正在录制视频音频：${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
  }

  async function beginWhisperPlayback() {
    if (whisperSession) return;
    const video = document.querySelector("video");
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("视频尚未加载，请先播放几秒后重试");
    }

    whisperSession = {
      video,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      wasPaused: video.paused
    };
    video.pause();
    video.currentTime = 0;
    video.playbackRate = 1;
    video.addEventListener("ended", finishWhisperCapture, { once: true });
    video.addEventListener("timeupdate", updateWhisperProgress);
    await video.play();
    const button = root?.querySelector(".ytse-whisper");
    if (button) button.textContent = "停止并识别当前录音";
    const cancelButton = root?.querySelector(".ytse-whisper-cancel");
    if (cancelButton) cancelButton.hidden = false;
    updateWhisperProgress();
  }

  async function cancelLocalWhisper() {
    if (fastWhisperRunning) {
      setStatus("正在取消快速转写…");
      try {
        await chrome.runtime.sendMessage({ type: "CANCEL_FAST_WHISPER" });
        resetWhisperControls();
        setStatus("快速转写已取消");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "取消失败", true);
      }
      return;
    }
    if (!whisperSession) return;
    setStatus("正在取消本地识别…");
    restoreVideo();
    try {
      await chrome.runtime.sendMessage({ type: "CANCEL_LOCAL_WHISPER" });
      setStatus("本地识别已取消");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "取消失败", true);
    }
  }

  async function startFastWhisper(button, transcriptionMode = "fast") {
    root?.querySelectorAll(".ytse-accurate-whisper, .ytse-fast-whisper").forEach((item) => {
      item.disabled = true;
    });
    const accurate = transcriptionMode === "accurate";
    setStatus(accurate ? "正在启动高准确率本地转写…" : "正在启动较快本地转写…");
    try {
      const metadata = getWhisperMetadata();
      metadata.transcriptionMode = transcriptionMode;
      const response = await chrome.runtime.sendMessage({
        type: "START_FAST_WHISPER",
        metadata
      });
      if (!response?.ok) throw new Error(response?.error || "无法启动快速转写");
      fastWhisperRunning = true;
      const cancelButton = root?.querySelector(".ytse-whisper-cancel");
      if (cancelButton) cancelButton.hidden = false;
      button.textContent = accurate ? "高准确率转写进行中…" : "较快转写进行中…";
    } catch (error) {
      resetWhisperControls();
      setStatus(error instanceof Error ? error.message : "无法启动快速转写", true);
    }
  }

  async function finishWhisperCapture() {
    if (!whisperSession) return;
    const button = root?.querySelector(".ytse-whisper");
    if (button) button.disabled = true;
    setStatus("录音完成，正在准备本地识别…");
    restoreVideo();
    try {
      const response = await chrome.runtime.sendMessage({ type: "STOP_LOCAL_WHISPER" });
      if (!response?.ok) throw new Error(response?.error || "停止录音失败");
    } catch (error) {
      if (button) button.disabled = false;
      setStatus(error instanceof Error ? error.message : "停止录音失败", true);
    }
  }

  async function startLocalWhisper(button) {
    if (whisperSession) {
      await finishWhisperCapture();
      return;
    }

    button.disabled = true;
    setStatus("正在启动当前标签页音频捕获…");
    let captureStarted = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_LOCAL_WHISPER",
        metadata: getWhisperMetadata()
      });
      if (!response?.ok) throw new Error(response?.error || "无法启动本地识别");
      captureStarted = true;
      await beginWhisperPlayback();
    } catch (error) {
      if (captureStarted) {
        chrome.runtime.sendMessage({ type: "CANCEL_LOCAL_WHISPER" }).catch(() => {});
      }
      const message = error instanceof Error ? error.message : "无法启动本地识别";
      const needsToolbar = /invoked|active tab|gesture/i.test(message);
      setStatus(
        needsToolbar
          ? "请点击浏览器工具栏里的插件图标开始本地识别"
          : message,
        true
      );
    } finally {
      button.disabled = false;
    }
  }

  function addWhisperOption(list) {
    const heading = document.createElement("div");
    heading.className = "ytse-section-title";
    heading.textContent = "Whisper 本地转写";
    const languageRow = document.createElement("label");
    languageRow.className = "ytse-language-row";
    languageRow.innerHTML = `
      <span>口播语言</span>
      <select class="ytse-language">
        <option value="auto">自动检测</option>
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
        <option value="es">Español</option>
        <option value="fr">Français</option>
        <option value="de">Deutsch</option>
        <option value="ru">Русский</option>
        <option value="pt">Português</option>
        <option value="it">Italiano</option>
        <option value="ar">العربية</option>
        <option value="hi">हिन्दी</option>
        <option value="vi">Tiếng Việt</option>
      </select>`;
    const actions = document.createElement("div");
    actions.className = "ytse-whisper-actions";
    const accurateButton = document.createElement("button");
    accurateButton.type = "button";
    accurateButton.className = "ytse-track ytse-accurate-whisper";
    accurateButton.textContent = "高准确率转写（推荐）";
    accurateButton.addEventListener("click", () => startFastWhisper(accurateButton, "accurate"));
    const fastButton = document.createElement("button");
    fastButton.type = "button";
    fastButton.className = "ytse-track ytse-fast-whisper";
    fastButton.textContent = "较快转写（浏览器 Base）";
    fastButton.addEventListener("click", () => startFastWhisper(fastButton, "fast"));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytse-track ytse-whisper";
    button.textContent = "备用：播放录制模式";
    button.addEventListener("click", () => startLocalWhisper(button));
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ytse-whisper-cancel";
    cancelButton.textContent = "取消";
    cancelButton.hidden = true;
    cancelButton.addEventListener("click", cancelLocalWhisper);
    actions.append(accurateButton, cancelButton);
    list.append(heading, languageRow, actions, fastButton, button);
  }

  function subtitleTrackLabel(track) {
    const name = track.name || track.languageCode || "字幕";
    const autoLabel = track.kind === "asr" && !/自动生成|auto-generated/i.test(name)
      ? "（自动生成）"
      : "";
    return `${name}${autoLabel}`;
  }

  function createSubtitleButton(track, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ytse-track ${className}`.trim();
    button.textContent = subtitleTrackLabel(track);
    button.addEventListener("click", () => exportTrack(track, button));
    return button;
  }

  async function exportTrack(track, button) {
    button.disabled = true;
    setStatus("正在读取字幕…");
    try {
      const response = await fetch(YouTubeTranscript.json3Url(track.baseUrl), {
        credentials: "include"
      });
      if (!response.ok) throw new Error(`字幕请求失败 (${response.status})`);
      const body = await response.text();
      let cues;
      if (body.trim()) {
        try {
          cues = YouTubeTranscript.cuesFromJson3(JSON.parse(body));
        } catch (_) {
          throw new Error("YouTube 返回了无法识别的字幕格式");
        }
      } else {
        setStatus("字幕直连接口受限，正在改用页面文字稿…");
        cues = await getTranscriptFallback();
      }
      const text = YouTubeTranscript.transcriptToText(cues);
      if (!text) throw new Error("字幕内容为空");

      downloadText(
        text,
        YouTubeTranscript.safeFilename(document.title.replace(/ - YouTube$/, ""), track.languageCode)
      );
      setStatus("TXT 已开始下载");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败", true);
    } finally {
      button.disabled = false;
    }
  }

  async function openPanel() {
    const panel = root.querySelector(".ytse-panel");
    panel.hidden = false;
    const list = root.querySelector(".ytse-tracks");
    list.replaceChildren();
    setStatus("正在查找字幕…");

    const trackData = await getTracks();
    if (trackData === null) {
      setStatus("插件未能连接到播放器，请重新加载插件和视频页", true);
      return;
    }
    const tracks = trackData.tracks;
    detectedAudioLanguage = trackData.audioLanguage;
    if (!tracks.length) {
      addWhisperOption(list);
      setStatus("没有 YouTube 字幕，可用本地助手快速下载音频并识别");
      return;
    }

    const heading = document.createElement("div");
    heading.className = "ytse-section-title";
    heading.textContent = "YouTube 字幕（最快）";
    const preferredTrack = YouTubeTranscript.selectPreferredTrack(
      tracks,
      navigator.language,
      detectedAudioLanguage
    );
    const directButton = createSubtitleButton(preferredTrack, "ytse-direct-export");
    directButton.textContent = `一键导出字幕 TXT · ${subtitleTrackLabel(preferredTrack)}`;
    list.append(heading, directButton);

    if (tracks.length > 1) {
      const details = document.createElement("details");
      details.className = "ytse-track-details";
      const summary = document.createElement("summary");
      summary.textContent = `选择其他字幕（共 ${tracks.length} 条）`;
      const trackList = document.createElement("div");
      trackList.className = "ytse-track-list";
      for (const track of tracks) trackList.appendChild(createSubtitleButton(track));
      details.append(summary, trackList);
      list.appendChild(details);
    }

    setStatus("可直接导出 YouTube 字幕，也可使用 Whisper 重新识别");
    addWhisperOption(list);
  }

  function mount() {
    if (fastWhisperRunning) {
      chrome.runtime.sendMessage({ type: "CANCEL_FAST_WHISPER" }).catch(() => {});
      fastWhisperRunning = false;
    }
    if (whisperSession) {
      chrome.runtime.sendMessage({ type: "CANCEL_LOCAL_WHISPER" }).catch(() => {});
      restoreVideo();
    }
    root?.remove();
    root = undefined;
    if (!isVideoPage()) return;

    root = document.createElement("div");
    root.id = "yt-subtitle-exporter";
    root.innerHTML = `
      <button class="ytse-trigger" type="button" aria-label="导出 YouTube 字幕">导出字幕 TXT</button>
      <section class="ytse-panel" hidden>
        <div class="ytse-header">
          <strong>选择字幕</strong>
          <button class="ytse-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="ytse-tracks"></div>
        <p class="ytse-status" aria-live="polite"></p>
      </section>`;
    root.querySelector(".ytse-trigger").addEventListener("click", openPanel);
    root.querySelector(".ytse-close").addEventListener("click", () => {
      root.querySelector(".ytse-panel").hidden = true;
    });
    document.body.appendChild(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
  document.addEventListener("yt-navigate-finish", mount);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "REQUEST_WHISPER_SETTINGS") {
      sendResponse({ metadata: getWhisperMetadata() });
      return;
    }
    if (message?.type === "WHISPER_CAPTURE_STARTED") {
      openPanel();
      beginWhisperPlayback().catch((error) => {
        chrome.runtime.sendMessage({ type: "CANCEL_LOCAL_WHISPER" }).catch(() => {});
        setStatus(error.message, true);
      });
      return;
    }
    if (message?.type === "WHISPER_FAST_STARTED") {
      openPanel().then(() => {
        fastWhisperRunning = true;
        const mode = message.metadata?.transcriptionMode || "accurate";
        const button = root?.querySelector(
          mode === "accurate" ? ".ytse-accurate-whisper" : ".ytse-fast-whisper"
        );
        const cancelButton = root?.querySelector(".ytse-whisper-cancel");
        root?.querySelectorAll(".ytse-accurate-whisper, .ytse-fast-whisper").forEach((item) => {
          item.disabled = true;
        });
        if (button) {
          button.textContent = mode === "accurate"
            ? "高准确率转写进行中…"
            : "较快转写进行中…";
        }
        if (cancelButton) cancelButton.hidden = false;
      });
      return;
    }
    if (message?.type === "WHISPER_STATUS") {
      setStatus(message.message || "正在本地识别…");
      return;
    }
    if (message?.type === "WHISPER_COMPLETE") {
      restoreVideo();
      downloadText(
        message.text,
        YouTubeTranscript.safeFilename(
          `${message.metadata?.title || document.title.replace(/ - YouTube$/, "")} ${
            message.metadata?.transcriptionMode === "accurate" ? "[Whisper Large v3]" : "[Whisper Base]"
          }`,
          "auto"
        )
      );
      setStatus("本地识别完成，TXT 已开始下载");
      return;
    }
    if (message?.type === "WHISPER_ERROR") {
      restoreVideo();
      setStatus(message.error || "本地识别失败", true);
      return;
    }
    if (message?.type === "WHISPER_CANCELLED") {
      restoreVideo();
      setStatus("本地识别已取消");
    }
  });
})();
