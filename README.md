# exclusive-dawn（已归档）

原 Dawn WeChat 桥接项目——把 Claude Code / Codex 接入微信的 Node.js 方案。

**当前状态：已停用，由 [晨曦微信机器人](../WeChatBot_WXAUTO_SE-3.24.6) 替代。**

---

## 这是什么

Dawn 把本地 AI（Claude Code 或 Codex）接入微信，支持：
- 微信消息双向传递（通过微信 HTTP 桥接）
- 随机 check-in（定时唤醒 AI）
- 本地日记写入
- 提醒队列
- 时间线记录

和晨曦的区别：这个版本用的是微信 web 协议（HTTP 桥接），不依赖桌面客户端自动化，但稳定性不如 wxautox4。

---

## 怎么重新启动

```powershell
# 开启计划任务（当初禁用的那个）
Enable-ScheduledTask -TaskName "Cyberboss Local Autostart"

# 或者直接手动启动
cd D:\GitHub\exclusive-dawn
node bin\exclusive-dawn.js start --checkin
```

状态检查：
```powershell
node D:\GitHub\exclusive-dawn\scripts\shared-status.js
```

---

## 环境变量

`.env` 文件关键配置：

```dotenv
DAWN_USER_NAME=白昼
DAWN_USER_GENDER=female
DAWN_ALLOWED_USER_IDS=wxid_xxx
DAWN_WORKSPACE_ROOT=D:\GitHub\exclusive-dawn
DAWN_RUNTIME=claudecode
```

---

## 目录结构

```
bin/exclusive-dawn.js     入口
src/
  adapters/channel/weixin/   微信桥接层
  adapters/runtime/claudecode/  Claude Code 适配
  adapters/runtime/codex/       Codex 适配
  core/                     核心逻辑
  services/                 工具服务
  tools/                    MCP 工具
scripts/                    启动/状态脚本
templates/                  配置模板
```

运行时状态存在 `C:\Users\happy\.exclusive-dawn\`（账号、会话、日记、提醒队列等）。

---

上游项目：[WenXiaoWendy/exclusive-dawn](https://github.com/WenXiaoWendy/exclusive-dawn)，AGPL-3.0
