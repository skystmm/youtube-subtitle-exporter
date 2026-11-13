#!/bin/zsh
set -euo pipefail

host_name="com.skystmm.video_subtitle_helper"
agent_label="com.skystmm.video-subtitle-helper"
agent_path="$HOME/Library/LaunchAgents/$agent_label.plist"
chrome_manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$host_name.json"
edge_manifest="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$host_name.json"

launchctl bootout "gui/$UID" "$agent_path" >/dev/null 2>&1 || true
rm -f "$agent_path" "$chrome_manifest" "$edge_manifest"

echo "本地助手的自动启动和 Native Messaging 注册已移除。"
echo "模型缓存和项目文件没有删除。"
