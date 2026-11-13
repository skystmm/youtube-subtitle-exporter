(() => {
  let root;
  let cues = [];
  let activeCueIndex = -1;
  let video;

  function isVideoPage() {
    return Boolean(BilibiliTranscript.extractBvid(location.pathname));
  }

  function currentVideoKey() {
    const bvid = BilibiliTranscript.extractBvid(location.pathname);
    if (!bvid) return null;
    const pageNumber = new URLSearchParams(location.search).get("p") || "1";
    return `${bvid}:${pageNumber}`;
  }

  function setStatus(message, isError = false) {
    const status = root?.querySelector(".bste-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.error = String(isError);
  }

  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
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

  async function requestJson(url) {
    const response = await chrome.runtime.sendMessage({ type: "BILIBILI_FETCH_JSON", url });
    if (!response?.ok) throw new Error(response?.error || "B 站接口请求失败");
    return response.data;
  }

  async function loadTracks() {
    const bvid = BilibiliTranscript.extractBvid(location.pathname);
    if (!bvid) throw new Error("当前不是标准 B 站视频页");
    const videoResponse = await requestJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    );
    if (videoResponse?.code !== 0) throw new Error(videoResponse?.message || "无法读取视频信息");
    const pageNumber = Number(new URLSearchParams(location.search).get("p") || 1);
    const page = BilibiliTranscript.selectPage(videoResponse.data, pageNumber);
    if (!page?.cid) throw new Error("无法确定当前分 P 的 cid");
    const playerResponse = await requestJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(page.cid)}`
    );
    if (playerResponse?.code !== 0) throw new Error(playerResponse?.message || "无法读取字幕轨道");
    return {
      title: videoResponse.data.title || document.title.replace(/_哔哩哔哩_bilibili$/, ""),
      tracks: BilibiliTranscript.normalizeTracks(playerResponse.data)
    };
  }

  function seekTo(startMs) {
    video ||= document.querySelector("video");
    if (!video) {
      setStatus("播放器尚未加载", true);
      return;
    }
    video.currentTime = startMs / 1000;
    video.play().catch(() => {});
  }

  function renderCues() {
    const list = root.querySelector(".bste-cues");
    list.replaceChildren();
    cues.forEach((cue, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bste-cue";
      button.dataset.index = String(index);
      button.innerHTML = `<time>${formatTime(cue.startMs)}</time><span></span>`;
      button.querySelector("span").textContent = cue.text;
      button.addEventListener("click", () => seekTo(cue.startMs));
      list.appendChild(button);
    });
  }

  function updateActiveCue() {
    video ||= document.querySelector("video");
    if (!video || !cues.length) return;
    const now = video.currentTime * 1000;
    let nextIndex = cues.findIndex((cue) => now >= cue.startMs && now < cue.endMs);
    if (nextIndex < 0) {
      nextIndex = cues.findLastIndex((cue) => cue.startMs <= now);
    }
    if (nextIndex === activeCueIndex) return;
    root?.querySelector(`.bste-cue[data-index="${activeCueIndex}"]`)?.classList.remove("is-active");
    const active = root?.querySelector(`.bste-cue[data-index="${nextIndex}"]`);
    active?.classList.add("is-active");
    if (root?.querySelector(".bste-follow")?.checked) {
      active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    activeCueIndex = nextIndex;
  }

  function watchPlayer() {
    if (video) video.removeEventListener("timeupdate", updateActiveCue);
    video = document.querySelector("video");
    video?.addEventListener("timeupdate", updateActiveCue);
    updateActiveCue();
  }

  async function chooseTrack(track, title) {
    setStatus(`正在读取${track.name}…`);
    try {
      const data = await requestJson(track.url);
      cues = BilibiliTranscript.cuesFromJson(data);
      if (!cues.length) throw new Error("字幕内容为空");
      root.dataset.title = title;
      root.dataset.language = track.languageCode;
      renderCues();
      watchPlayer();
      setStatus(`共 ${cues.length} 条字幕 · 点击字幕可跳转`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "字幕读取失败", true);
    }
  }

  async function openPanel() {
    const panel = root.querySelector(".bste-panel");
    panel.hidden = false;
    root.querySelector(".bste-track-select").hidden = true;
    root.querySelector(".bste-cues").replaceChildren();
    setStatus("正在查找字幕…");
    try {
      const { title, tracks } = await loadTracks();
      if (!tracks.length) throw new Error("这个视频没有可用字幕");
      const select = root.querySelector(".bste-track-select");
      select.replaceChildren();
      for (const track of tracks) {
        const option = document.createElement("option");
        option.value = String(tracks.indexOf(track));
        option.textContent = track.name;
        select.appendChild(option);
      }
      const preferred = BilibiliTranscript.selectPreferredTrack(tracks, navigator.language);
      select.value = String(tracks.indexOf(preferred));
      select.hidden = tracks.length < 2;
      select.onchange = () => chooseTrack(tracks[Number(select.value)], title);
      await chooseTrack(preferred, title);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "无法加载字幕", true);
    }
  }

  function enableDragging(panel, handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, select, input, label")) return;
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, moveEvent.clientX - offsetX))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - 60, moveEvent.clientY - offsetY))}px`;
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
    });
  }

  function mount() {
    root?.remove();
    root = undefined;
    cues = [];
    activeCueIndex = -1;
    if (!isVideoPage()) return;
    root = document.createElement("div");
    root.id = "bilibili-subtitle-transcript";
    root.dataset.videoKey = currentVideoKey() || "";
    root.innerHTML = `
      <button class="bste-trigger" type="button">文字稿</button>
      <section class="bste-panel" hidden>
        <header class="bste-header">
          <strong>视频文字稿</strong>
          <select class="bste-track-select" aria-label="字幕语言" hidden></select>
          <button class="bste-close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="bste-toolbar">
          <label><input class="bste-follow" type="checkbox" checked> 自动跟随</label>
          <button class="bste-copy" type="button">复制全文</button>
          <button class="bste-download" type="button">导出 TXT</button>
        </div>
        <div class="bste-cues"></div>
        <p class="bste-status" aria-live="polite"></p>
      </section>`;
    const panel = root.querySelector(".bste-panel");
    root.querySelector(".bste-trigger").addEventListener("click", openPanel);
    root.querySelector(".bste-close").addEventListener("click", () => { panel.hidden = true; });
    root.querySelector(".bste-copy").addEventListener("click", async () => {
      const text = BilibiliTranscript.transcriptToText(cues);
      if (!text) return setStatus("还没有可复制的字幕", true);
      try {
        await navigator.clipboard.writeText(text);
        setStatus("字幕全文已复制");
      } catch (_) {
        setStatus("复制失败，请直接选中文字复制", true);
      }
    });
    root.querySelector(".bste-download").addEventListener("click", () => {
      const text = BilibiliTranscript.transcriptToText(cues);
      if (!text) return setStatus("还没有可导出的字幕", true);
      downloadText(text, BilibiliTranscript.safeFilename(root.dataset.title, root.dataset.language));
      setStatus("TXT 已开始下载");
    });
    enableDragging(panel, root.querySelector(".bste-header"));
    document.body.appendChild(root);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
  window.addEventListener("popstate", mount);
  window.setInterval(() => {
    const nextKey = currentVideoKey();
    if ((nextKey && root?.dataset.videoKey !== nextKey) || (!nextKey && root)) mount();
  }, 750);
})();
