# @qingshanjiluo/dsh-plugin-suite

**聚合版一键安装 / 配置工具**：一条命令把本合集的 **47 个 `@qingshanjiluo/dsh-*` 插件**启用进某个 DeepSeek Harness（dsh）profile，并可覆写各插件配置、查看状态、批量卸载。

- 纯 Node 内置模块实现（`bin/dsh-suite.mjs`），无第三方运行时依赖；对 dsh/pnpm 的调用一律 `spawnSync`（不经 shell，Windows 安全）。
- 插件清单内嵌在 `plugins.json`（47 条：包名 / 工具 / 简介 / 配置键）。
- **不会自动重启 DSH**；启用后需你重启该 profile 才在运行实例生效，可用 `dsh --profile <p> --dump-config` 在重启前预览。

## 安装本工具

发布到 npm 后（见下）可免安装直接用：

```bash
npx -y @qingshanjiluo/dsh-plugin-suite list
npx -y @qingshanjiluo/dsh-plugin-suite install --profile web
```

本地（本仓库内，尚未发布 npm 时）：

```bash
node bin/dsh-suite.mjs <command> ...
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `list [--json]` | 列出全部插件（包名 / 注册工具 / 简介） |
| `install [-p web] [--strategy dsh\|batch] [--from npm\|local] [--src <dir>] [--only a,b] [-n]` | 一键启用插件（默认全部 47） |
| `uninstall [-p web] [--only a,b] [-n]` | 批量卸载（收敛依赖后单次 pnpm install） |
| `status [-p web] [--dump]` | 查看套件内已启用数；`--dump` 额外跑 `dsh --dump-config` 统计 bundle 实际纳入层数 |
| `configure -p web --set <插件>.<键>=<值> [--set ...] [-n]` | 覆写插件配置（写入 profile 的 `cordis.patch.yml`） |
| `doctor` | 检查 dsh 解析、DSH_HOME、profile 路径 |

**常用：**

```bash
# 全量启用进 web（走 dsh plugin add，最稳）
dsh-suite install --profile web --from npm

# 先看要做什么，不动盘
dsh-suite install --profile web --dry-run

# 只装一部分
dsh-suite install --profile web --from npm --only dsh-commit-lint,dsh-prometheus,dsh-security-audit

# 配置某个插件（重启后生效）
dsh-suite configure --profile web --set dsh-prometheus.url=http://prom.internal:9090 --set dsh-prometheus.timeoutMs=8000

# 查看启用情况 + bundle 佐证
dsh-suite status --profile web --dump

# 全部卸载
dsh-suite uninstall --profile web
```

### 选项说明

- `--strategy dsh`（默认）：逐个 `dsh plugin --profile <p> add <spec>`，dsh 官方姿势，最稳。
- `--strategy batch`（实验、更快）：把依赖一次性写入 profile 的 `package.json` 再跑**一次** `pnpm install`。要求 profile 已初始化。
- `--from npm`（默认）：`@qingshanjiluo/<名>@latest`，需插件已发布到 npm。
- `--from local --src <dir>`：从本地目录 `link:`（`<dir>` 是含 `dsh-*` 子目录、且已 `npm run build` 出 `lib/` 的仓库根）。**在未发布 npm 前用这个可立即体验。**
- `--from github`：pnpm `github:qingshanjiluo/<名>`。**注意**：本合集各仓库的 `lib/` 被 `.gitignore` 排除、未进 git，而 dsh 运行需要 `lib/index.js`；除非为各包加 `"prepare": "npm run build"` 自举，否则从 github 安装会缺产物。发布 npm 后请优先用 `--from npm`。
- `-p/--profile` 目标 profile 名（默认 `web`）；`-n/--dry-run` 只打印；`-v/--verbose` 打印将执行的命令。

## 发布到 npm（两步）

`@qingshanjiluo/dsh-*` 目前是**本地目录 / GitHub 仓库**，尚未发布 npm。要用 `--from npm` 需先发布。发布需你本人的 npmjs 凭据（我无法代登录）：

**第 1 步 · 拥有 scope 并登录**（`@qingshanjiluo` 目前在 npmjs 无人占用）：

```bash
# 二选一
#   (a) 用名为 qingshanjiluo 的 npm 账号：直接注册/登录，个人同名 scope 即归你
#   (b) 建一个名为 qingshanjiluo 的 npm 组织（公共包免费）：npm org 创建后登录其成员
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org   # 确认身份
```

> 本机默认 registry 常是 `registry.npmmmirror.com`（只读镜像，不能发布）。发布脚本会显式带 `--registry https://registry.npmjs.org`，无需改全局配置。

**第 2 步 · 运行发布脚本**（先校验后发布，已存在的包自动跳过，可断点续发）：

```bash
cd dsh-plugin-suite
node scripts/publish-all.mjs --pack-only        # 只做本地打包校验（无需登录）：应 48/48 就绪
node scripts/publish-all.mjs --yes              # 真正发布（47 插件 + 本套件工具）
# 或从 CI 用 token：NPM_TOKEN=*** node scripts/publish-all.mjs --yes --token-env
```

发布成功后，任何人一条命令即可全量启用：

```bash
npx -y @qingshanjiluo/dsh-plugin-suite install --profile web --from npm
```

## 已验证行为（一次性隔离 profile 端到端）

install 3/3 成功 → `status --dump` 显示 `bundle 实纳入 @qingshanjiluo 插件层：3` → `configure --set dsh-prometheus.url/timeoutMs` 写入 `cordis.patch.yml` 且在 `dsh --dump-config` 里显示 `patched by …cordis.patch.yml` 的 `url: http://prom.example:9090`（覆写进入 compose）→ 再次 `configure` 幂等更新不重复 → `uninstall` 后依赖归 0。全程未触碰运行中的实例。

## 许可

MIT
