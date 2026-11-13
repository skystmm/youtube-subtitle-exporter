(function (root, factory) {
  const api = factory();
  root.HelperLauncher = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function nativeHostInstallError(extensionId, reason = "") {
    const suffix = reason ? `（${reason}）` : "";
    return `本地助手尚未安装或未注册${suffix}。请运行扩展目录中的 install-helper.command，扩展 ID：${extensionId}`;
  }

  async function ensureLocalHelper({
    checkHealth,
    startNative,
    sleep,
    attempts = 30,
    extensionId = "未知"
  }) {
    if (await checkHealth()) return { ok: true, status: "already_running" };

    let response;
    try {
      response = await startNative();
    } catch (error) {
      throw new Error(nativeHostInstallError(extensionId, error?.message));
    }
    if (!response?.ok) {
      throw new Error(response?.error || nativeHostInstallError(extensionId));
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(100);
      if (await checkHealth()) return { ok: true, status: response.status || "started" };
    }
    throw new Error("本地助手启动超时，请检查 ~/Library/Logs/video-subtitle-helper.log");
  }

  return { ensureLocalHelper, nativeHostInstallError };
});
