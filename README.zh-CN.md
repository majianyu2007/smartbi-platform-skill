# Smartbi Platform Skill

[English](README.md) | **简体中文**

面向 Smartbi Insight V11 的 API-first 自动化 Skill。支持登录、目录、数据导入、自助 ETL、数据模型、透视分析、仪表盘、AIChat 和 Agent；只有无法安全推断的可视化操作才使用 Playwright/CDP。

## 环境要求

| 环境 | 是否必需 | 最低要求 | 自动探测 |
|---|---:|---|---:|
| Node.js | 是 | 20 或更高版本 | 是 |
| npm | 安装 Playwright 时需要 | 随 Node.js 提供 | 是 |
| Playwright | API-only 模式不需要；浏览器备用模式需要 | 推荐 `1.62.1` | 是 |
| Chrome/Chromium | 仅浏览器备用模式需要 | 支持 CDP | 是 |

API 核心路径没有第三方 npm 依赖，因此不需要先运行 `npm install`。

## 1. 安装 Skill

### Codex / Oh My Pi

```bash
git clone https://github.com/your-org/smartbi-platform-skill.git \
  ~/.codex/skills/smartbi-platform
cd ~/.codex/skills/smartbi-platform
./scripts/install.sh --check
```

若目录已经存在：

```bash
cd ~/.codex/skills/smartbi-platform
git pull --ff-only
./scripts/install.sh --check
```

其他支持 Skill 目录的客户端，只需把仓库复制或克隆到客户端的 Skill 根目录，并保持目录名为 `smartbi-platform`。

### Windows

`install.sh` 适用于 macOS/Linux。Windows 直接运行相同的 Node 检查器：

```powershell
node scripts/install.mjs --check
```

## 2. 自动环境探测

安装检查器会自动判断：

1. Node.js 是否存在、是否达到 20+；
2. npm 是否存在；
3. Playwright 能否通过项目依赖、专用安装、OMP 内置运行时或显式路径复用；
4. 本机是否有 Chrome、Edge、Chromium 或 Playwright Chromium；
5. `SMARTBI_CDP_URL` 指向的有头浏览器是否正在运行；
6. API 核心与浏览器备用模式分别是否就绪。

普通文本输出：

```bash
./scripts/install.sh --check
```

机器可读 JSON：

```bash
./scripts/install.sh --check --json
```

也可以通过 Skill CLI 检查：

```bash
node scripts/smartbi.mjs doctor
node scripts/smartbi.mjs doctor --require-browser
```

`doctor` 不读取或输出密码。

### 返回码

| 返回码 | 含义 |
|---:|---|
| `0` | Node.js 满足要求；API 核心可用 |
| `1` | 环境检查失败，或 `--require-browser` 要求的浏览器备用模式未就绪 |
| `2` | `install.sh` 找不到 Node.js，或 Node.js 版本低于 20 |

## 3. Node.js 缺失时

安装器本身先由 POSIX shell 检查 Node.js，因此 Node 缺失时仍能给出明确结果。

推荐安装当前 Node.js LTS：<https://nodejs.org/>

```bash
# macOS（Homebrew）
brew install node@22

# Windows
winget install OpenJS.NodeJS.LTS
```

Linux 请使用发行版包管理器或 Node.js 官方安装包。安装后重新运行：

```bash
./scripts/install.sh --check
```

## 4. Playwright 是否需要安装

Playwright **不是 API 核心流程的必需依赖**。以下操作不需要打开浏览器：

- 登录与目录查询；
- 数据导入；
- 自助 ETL；
- 数据模型；
- 透视分析与 API 生成仪表盘；
- AIChat 图谱、问答、报告和导出；
- Agent 创建、运行和部署。

只有复杂画布编辑、无法安全推断端口的 ETL 节点等备用操作需要 Playwright。

检查器按以下顺序自动复用 Playwright：

1. `SMARTBI_PLAYWRIGHT_PATH`；
2. Skill 本地 `node_modules/playwright`；
3. `~/.local/share/smartbi-platform/playwright` 专用安装；
4. `~/.local/share/omp-playwright` 的 OMP 内置运行时。

如果任一路径可用，就不会重复安装。

### 安装 Playwright 模块

```bash
./scripts/install.sh --install-playwright
```

专用安装位置：

```text
~/.local/share/smartbi-platform/playwright
```

该命令默认只安装 Playwright 模块，不额外下载 Chromium；如果本机已有 Chrome，这足以连接 CDP。

### 同时安装 Playwright Chromium

```bash
./scripts/install.sh --install-playwright --with-browser
```

安装动作必须显式请求。普通 `--check` 和 `doctor` 永远不会修改系统。

## 5. 启动有头浏览器备用模式

macOS 示例：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/tmp/smartbi-playwright-profile-cdp \
  https://your-host.example/smartbi/vision/index.jsp
```

浏览器必须保持运行。然后检查：

```bash
node scripts/smartbi.mjs doctor --require-browser
```

默认 CDP 地址为 `http://127.0.0.1:9222`，可用 `SMARTBI_CDP_URL` 覆盖。

## 6. 首次配置

交互式配置：

```bash
node scripts/smartbi.mjs setup --interactive
```

向导会询问：

1. Smartbi Vision Base URL，必须以 `/vision` 结尾；
2. 登录账号；
3. 登录密码，终端不回显；
4. 命名模式：`prefix` 或 `suffix`；
5. 命名空间标记，例如 `TEAM_` 或 `_TEAM`。

非交互式配置：

```bash
node scripts/smartbi.mjs setup \
  --base-url https://your-host.example/smartbi/vision \
  --cred-file /path/to/credentials.txt \
  --namespace TEAM_ \
  --naming prefix
```

凭据文件格式：

```text
第一行：账号
第二行：密码
```

凭据文件和生成的配置文件应保持 `0600` 权限。凭据文件不会提交到仓库。

## 7. 安装后验收

```bash
node scripts/smartbi.mjs doctor
node scripts/smartbi.mjs config
node scripts/smartbi.mjs codec-status --refresh
node scripts/smartbi.mjs login
node scripts/smartbi.mjs health
```

预期结果：

- `doctor.readiness.apiCore` 为 `true`；
- `codec-status` 返回已发现的 `SF1`、`SF2` 或 `SF3`；
- `login.retCode` 为 `0`；
- `health.state` 为 `workspace`。

需要验证浏览器备用模式时：

```bash
node scripts/smartbi.mjs doctor --require-browser
```

## 8. 迁移到另一台主机或另一套 Smartbi

迁移时不要复制会话 Cookie。执行：

1. 克隆 Skill 仓库；
2. 运行 `./scripts/install.sh --check`；
3. 根据检查结果决定是否安装 Node.js 或 Playwright；
4. 运行 `setup --interactive` 配置新租户、凭据和命名空间；
5. 运行 `codec-status --refresh`。

传输编码器会从新租户的前端资源自动发现，并按 Base URL 与 SHA-256 指纹独立缓存。旧租户的 Code 映射不会用于新租户。

## 9. 环境变量

| 变量 | 用途 |
|---|---|
| `SMARTBI_CONFIG_FILE` | 指定配置文件 |
| `SMARTBI_BASE_URL` | 指定 Smartbi Vision 根地址 |
| `SMARTBI_CDP_URL` | 指定浏览器 CDP 地址 |
| `SMARTBI_CRED_FILE` | 指定两行凭据文件 |
| `SMARTBI_CODEC_CACHE_FILE` | 指定传输编码器缓存 |
| `SMARTBI_PLAYWRIGHT_PATH` | 指定 Playwright 包目录或入口文件 |
| `SMARTBI_BROWSER_PATH` | 指定 Chrome/Chromium 可执行文件 |
| `SMARTBI_NAMESPACE` | 覆盖资源命名空间 |
| `SMARTBI_NAMING` | `prefix` 或 `suffix` |

## 10. 开发验证

```bash
npm test
# 等价于：
node --test tests/*.test.mjs
```

语法检查：

```bash
node --check scripts/install.mjs
node --check scripts/transport-codec.mjs
node --check scripts/aichat-stream.mjs
node --check scripts/import-schema.mjs
node --check scripts/deletion-guard.mjs
node --check scripts/smartbi.mjs
sh -n scripts/install.sh
```

## 安全边界

- 检查器只读取版本、文件是否存在和 CDP 状态；默认不安装任何软件。
- 安装 Playwright 必须显式传入 `--install-playwright`。
- 密码只从私有凭据文件读取，不进入环境报告、日志、缓存或 Git。
- 所有平台写操作仍受命名空间与个人工作区所有权检查保护。
- `upload --replace` 仅在新文件字段名及顺序与现有表完全一致时执行；
  字段新增、删除或重排会在写入前失败，防止平台静默丢列。
- 清理旧版未命名空间化资源时，只允许删除当前登录账号个人数据采集空间中的直接子级 `BASETABLE`，并且必须提供用户确认的精确名称：
  `resource-delete <parentId> <resourceId> --confirm-name <exactName>`。
- 精确名称确认不能授权删除共享目录资源或非表资源。
