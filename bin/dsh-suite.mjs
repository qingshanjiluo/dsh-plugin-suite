#!/usr/bin/env node
/**
 * dsh-suite — 一键安装 / 配置 / 卸载 qingshanjiluo 的 @qingshanjiluo/dsh-* 插件套件。
 *
 * 面向 DeepSeek Harness（dsh）profile：把本仓库收录的全部插件按你的选择启用，
 * 并可覆写各插件配置。仅依赖 Node 内置模块；对 dsh / pnpm 的调用一律用
 * spawnSync（不经过 shell，跨平台、Windows 安全）。
 *
 * 默认策略 dsh：逐个 `dsh plugin --profile <p> add <spec>`（dsh 官方姿势，最稳）。
 * 可选 batch：把依赖一次性写入 profile 的 package.json 再跑一次 pnpm install（更快）。
 *
 * 绝不自动重启 DSH；启用后需你自行重启才在运行实例生效，可用
 * `dsh --profile <p> --dump-config` 在重启前预览插件是否已纳入 bundle。
 *
 * @module @qingshanjiluo/dsh-plugin-suite
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'qingshanjiluo'
const SCOPE = `@${OWNER}/`
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')

/** 载入内嵌的插件清单。 */
function loadPlugins() {
  const raw = readFileSync(join(PKG_ROOT, 'plugins.json'), 'utf8')
  return JSON.parse(raw)
}

/** DSH_HOME 解析（与 dsh 一致：$DSH_HOME 或 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 解析一个可用的 dsh 命令：显式覆盖 → 全局 dsh → npx 兜底。 */
function dshCmd(override) {
  if (override) return override.split(' ').filter(Boolean)
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) return ['dsh']
  return ['npx', '-y', '@deepseek-ai/dsh']
}

/** 运行一条命令并捕获结果（不打印，除非 verbose）。cmd 可为字符串或 argv 数组。 */
function run(cmd, args, { profile, verbose, cwd } = {}) {
  const arr = Array.isArray(cmd) ? cmd : [cmd]
  const exe = arr[0]
  const fullArgs = [...arr.slice(1), ...(args || [])]
  if (verbose) process.stderr.write(`$ ${[exe, ...fullArgs].join(' ')}\n`)
  const r = spawnSync(exe, fullArgs, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', spawnErr: r.error ? r.error.message : '' }
}

/** 把 --from/--src 解析为某个插件的安装 spec。 */
function specFor(p, from, srcDir) {
  if (from === 'local') {
    if (!srcDir) throw new Error('--from local 需要 --src <本仓库根目录，内含 dsh-* 子目录>')
    const dir = resolve(srcDir, p.short)
    if (!existsSync(dir)) throw new Error(`本地目录不存在：${dir}`)
    return dir
  }
  if (from === 'github') return `github:${OWNER}/${p.short}`
  return `${p.pkg}@latest`
}

function parseArgs(argv) {
  const opts = { _: [], profile: 'web', strategy: 'dsh', from: 'npm', src: '', only: null, dryRun: false, verbose: false, sets: [], json: false, yes: false, dshBin: '', dump: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--profile': case '-p': opts.profile = argv[++i]; break
      case '--strategy': opts.strategy = argv[++i]; break
      case '--from': opts.from = argv[++i]; break
      case '--src': opts.src = argv[++i]; break
      case '--only': opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break
      case '--set': opts.sets.push(argv[++i]); break
      case '--dsh': opts.dshBin = argv[++i]; break
      case '--dry-run': case '-n': opts.dryRun = true; break
      case '--verbose': case '-v': opts.verbose = true; break
      case '--json': opts.json = true; break
      case '--dump': opts.dump = true; break
      case '--yes': case '-y': opts.yes = true; break
      case '--help': case '-h': opts.help = true; break
      default: opts._.push(a)
    }
  }
  if (!['dsh', 'batch'].includes(opts.strategy)) throw new Error(`未知 --strategy：${opts.strategy}（可用 dsh|batch）`)
  if (!['npm', 'github', 'local'].includes(opts.from)) throw new Error(`未知 --from：${opts.from}（可用 npm|github|local）`)
  return opts
}

function selectPlugins(plugins, opts) {
  if (!opts.only) return plugins
  const set = new Set(opts.only.map((s) => (s.startsWith(SCOPE) ? s.slice(SCOPE.length) : s)))
  const chosen = plugins.filter((p) => set.has(p.short))
  const unknown = [...set].filter((s) => !plugins.some((p) => p.short === s))
  if (unknown.length) throw new Error(`未知插件：${unknown.join(', ')}`)
  return chosen
}

const HELP = `dsh-suite — 一键安装/配置 qingshanjiluo 的 @qingshanjiluo/dsh-* 插件套件（共 <N> 个）

用法：
  dsh-suite list [--json]                       列出全部插件（包名/工具/简介）
  dsh-suite install [-p web] [--strategy dsh|batch] [--from npm|github|local] [--src <dir>] [--only a,b] [-n]
  dsh-suite uninstall [-p web] [--only a,b] [-n]
  dsh-suite status [-p web] [--dump]            查看 profile 里已启用的套件插件数（--dump 跑 dsh --dump-config 佐证）
  dsh-suite configure -p web --set <short>.<key>=<value> [--set ...] [-n]
  dsh-suite doctor                              检查 dsh/pnpm 可用性与 profile 路径

说明：
  --profile  目标 dsh profile 名（默认 web）
  --strategy dsh=逐个 dsh plugin add（默认，最稳）；batch=批量改 package.json + 一次 pnpm install（更快，实验性）
  --from     安装来源：npm（默认，需已发布）/ github / local（需 --src）
  --only     只处理逗号分隔的子集（short 或全名）
  -n/--dry-run  只打印将执行的动作
  注意：本工具不会重启 DSH；启用后需重启 profile 才在运行实例生效。
`

function main() {
  const argv = process.argv.slice(2)
  let opts
  try { opts = parseArgs(argv) } catch (e) { console.error('参数错误：' + e.message); process.exit(2) }
  const plugins = loadPlugins()
  const cmd = opts._[0]
  if (opts.help || !cmd) { process.stdout.write(HELP.replace('<N>', String(plugins.length))); return }

  try {
    if (cmd === 'list') return cmdList(plugins, opts)
    if (cmd === 'install') return cmdInstall(plugins, opts)
    if (cmd === 'uninstall') return cmdUninstall(plugins, opts)
    if (cmd === 'status') return cmdStatus(plugins, opts)
    if (cmd === 'configure') return cmdConfigure(plugins, opts)
    if (cmd === 'doctor') return cmdDoctor(opts)
    console.error('未知命令：' + cmd + '\n' + HELP.replace('<N>', String(plugins.length)))
    process.exit(2)
  } catch (e) {
    console.error('错误：' + e.message)
    process.exit(1)
  }
}

function cmdList(plugins, opts) {
  if (opts.json) { process.stdout.write(JSON.stringify(plugins, null, 2) + '\n'); return }
  for (const p of plugins) process.stdout.write(`${p.pkg}\t${p.tools.join(', ')}\t${p.description}\n`)
  process.stdout.write(`\n共 ${plugins.length} 个插件。\n`)
}

function cmdDoctor(opts) {
  const dc = dshCmd(opts.dshBin)
  const help = run(dc, ['--help'], { verbose: opts.verbose })
  const okDsh = help.code === 0 || /Usage: dsh/.test(help.stdout + help.stderr)
  process.stdout.write(`dsh 命令: ${dc.join(' ')}  可运行: ${okDsh ? 'yes' : 'no（' + (help.stderr || help.spawnErr).trim().split('\n')[0] + '）'}\n`)
  process.stdout.write(`DSH_HOME: ${dshHome()}\n`)
  process.stdout.write(`profiles 目录: ${join(dshHome(), 'profiles')}\n`)
  process.stdout.write(`pnpm（batch 策略用）: 通过 npx -y pnpm@11 调用\n`)
}

function ensureProfileDir(profile, opts, dc) {
  const dir = join(dshHome(), 'profiles', profile)
  if (existsSync(dir)) return dir
  if (opts.dryRun) { process.stdout.write(`(dry-run) 将初始化 profile ${profile}\n`); return dir }
  // 用 dsh 官方方式初始化（plugin add 会自动 scaffold profile）
  process.stdout.write(`profile "${profile}" 不存在，将由 dsh 首次调用时自动初始化于 ${dir}\n`)
  return dir
}

function cmdInstall(plugins, opts) {
  const chosen = selectPlugins(plugins, opts)
  const dc = dshCmd(opts.dshBin)
  const dir = ensureProfileDir(opts.profile, opts, dc)
  process.stdout.write(`安装 ${chosen.length} 个插件 → profile "${opts.profile}" （strategy=${opts.strategy}, from=${opts.from}）\n`)
  if (opts.strategy === 'batch') return batchInstall(chosen, opts, dir)
  let ok = 0; const failed = []
  for (const p of chosen) {
    const spec = specFor(p, opts.from, opts.src)
    if (opts.dryRun) { process.stdout.write(`  (dry-run) dsh plugin --profile ${opts.profile} add ${spec}\n`); ok++; continue }
    const r = run(dc, ['plugin', '--profile', opts.profile, 'add', spec], { verbose: opts.verbose })
    if (r.code === 0) { ok++; process.stdout.write(`  ✓ ${p.pkg}\n`) }
    else { failed.push(p.short); process.stdout.write(`  ✗ ${p.pkg} — ${(r.stderr || r.spawnErr || r.stdout).trim().split('\n').slice(-1)[0]}\n`) }
  }
  summarize('install', ok, chosen.length, failed)
  if (!opts.dryRun && chosen.length) {
    process.stdout.write(`\n提示：运行 dsh --profile ${opts.profile} --dump-config 预览 bundle；重启该 profile 后插件才在运行实例生效。\n`)
  }
}

function batchInstall(chosen, opts, dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath) && !opts.dryRun) {
    throw new Error(`batch 策略要求 profile 已初始化（缺少 ${pkgPath}）。请先用 --strategy dsh 安装一次，或手动 dsh --profile ${opts.profile} --dump-config 初始化。`)
  }
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { dependencies: {} }
  pkg.dependencies = pkg.dependencies || {}
  // dsh 只加载 dsh.profile.bundles 里列出的插件（或全部 deps，取决于版本）；为与
  // `dsh plugin add` 行为一致，batch 必须同时把包名登记进 bundles，否则“装了却不加载”。
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  const bundles = pkg.dsh.profile.bundles
  for (const p of chosen) {
    pkg.dependencies[p.pkg] = specFor(p, opts.from, opts.src)
    if (!bundles.includes(p.pkg)) bundles.push(p.pkg)
  }
  if (opts.dryRun) {
    process.stdout.write(`(dry-run) 将向 ${pkgPath} 写入 ${chosen.length} 个依赖并执行一次 pnpm install：\n`)
    for (const p of chosen) process.stdout.write(`  ${p.pkg}: ${pkg.dependencies[p.pkg]}\n`)
    return
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  process.stdout.write(`  已写入 package.json，正在 pnpm install（单次）…\n`)
  const r = run('npx', ['-y', 'pnpm@11', 'install'], { cwd: dir, verbose: opts.verbose })
  if (r.code !== 0) throw new Error('pnpm install 失败：' + (r.stderr || r.stdout).split('\n').slice(-3).join('\n'))
  process.stdout.write(`  ✓ pnpm install 完成，启用 ${chosen.length} 个插件\n`)
}

function cmdUninstall(plugins, opts) {
  const chosen = selectPlugins(plugins, opts)
  const dc = dshCmd(opts.dshBin)
  const dir = join(dshHome(), 'profiles', opts.profile)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) { process.stdout.write(`profile "${opts.profile}" 未初始化，无可卸载。\n`); return }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  const present = chosen.filter((p) => Object.prototype.hasOwnProperty.call(pkg.dependencies, p.pkg))
  process.stdout.write(`卸载 ${present.length} 个（从 profile "${opts.profile}"）\n`)
  if (opts.dryRun) { for (const p of present) process.stdout.write(`  (dry-run) 移除 ${p.pkg}\n`); return }
  for (const p of present) delete pkg.dependencies[p.pkg]
  if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
    const gone = new Set(present.map((p) => p.pkg))
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => !gone.has(b))
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  const r = run('npx', ['-y', 'pnpm@11', 'install'], { cwd: dir, verbose: opts.verbose })
  if (r.code !== 0) { process.stdout.write('pnpm install 返回非零：' + (r.stderr || r.stdout).split('\n').slice(-3).join('\n') + '\n'); return }
  void dc
  process.stdout.write(`  ✓ 已移除 ${present.length} 个并收敛依赖\n`)
}

function cmdStatus(plugins, opts) {
  const dir = join(dshHome(), 'profiles', opts.profile)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) { process.stdout.write(`profile "${opts.profile}" 未初始化于 ${dir}\n`); return }
  const deps = Object.keys((JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies) || {})
  const inSuite = plugins.filter((p) => deps.includes(p.pkg))
  process.stdout.write(`profile "${opts.profile}"：套件内已声明依赖 ${inSuite.length}/${plugins.length}\n`)
  const missing = plugins.filter((p) => !deps.includes(p.pkg)).map((p) => p.short)
  if (missing.length) process.stdout.write(`  未启用：${missing.join(', ')}\n`)
  if (opts.dump) {
    const dc = dshCmd(opts.dshBin)
    const r = run(dc, ['--profile', opts.profile, '--dump-config'], { verbose: opts.verbose })
    const layers = new Set([...String(r.stdout).matchAll(/# == @qingshanjiluo\/(dsh-[a-z0-9-]+)/g)].map((m) => m[1]))
    process.stdout.write(`  bundle 实纳入 @qingshanjiluo 插件层：${layers.size}（dsh --dump-config exit=${r.code}）\n`)
  }
}

/** 把 'short.key=value' 解析为 {short,key,value}（value 取第一个 = 之后全部内容）。 */
function parseSet(s) {
  const eq = s.indexOf('=')
  if (eq < 0) throw new Error(`--set 需形如 <插件>.<键>=<值>：${s}`)
  const lhs = s.slice(0, eq); const value = s.slice(eq + 1)
  const dot = lhs.indexOf('.')
  if (dot < 0) throw new Error(`--set 左侧需 <插件>.<键>：${s}`)
  let short = lhs.slice(0, dot)
  if (short.startsWith(SCOPE)) short = short.slice(SCOPE.length)
  return { short, key: lhs.slice(dot + 1), value }
}

function coerce(v) {
  if (v === 'true') return 'true'
  if (v === 'false') return 'false'
  if (v !== '' && !Number.isNaN(Number(v))) return v
  return JSON.stringify(v) // 其余按字符串带引号
}

function cmdConfigure(plugins, opts) {
  if (!opts.sets.length) throw new Error('configure 需要至少一个 --set <插件>.<键>=<值>')
  const dir = join(dshHome(), 'profiles', opts.profile)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(dir)) throw new Error(`profile "${opts.profile}" 不存在于 ${dir}（先 install）`)
  // 解析 --set，按插件聚合配置
  const byPlugin = new Map()
  for (const s of opts.sets) {
    const { short, key, value } = parseSet(s)
    const p = plugins.find((x) => x.short === short)
    if (!p) throw new Error(`未知插件 short：${short}`)
    if (!byPlugin.has(short)) byPlugin.set(short, {})
    byPlugin.get(short)[key] = value
  }
  // 读取现有 patch；仅接受"纯注释/空数组/本工具生成的 - id 条目"这一简单形状，否则拒绝避免误伤
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const entries = readPatchEntries(existing)
  for (const [short, kv] of byPlugin) {
    let ent = entries.find((e) => e.id === short)
    if (!ent) { ent = { id: short, config: {} }; entries.push(ent) }
    Object.assign(ent.config, kv)
  }
  const out = renderPatch(entries)
  if (opts.dryRun) { process.stdout.write(`(dry-run) 将写入 ${patchPath}：\n\n${out}`); return }
  writeFileSync(patchPath, out, 'utf8')
  process.stdout.write(`已更新 ${patchPath}\n\n${out}`)
  process.stdout.write(`提示：重启 profile "${opts.profile}" 后配置生效。\n`)
}

/** 极简解析：返回 [{id, config:{...}}]。只认本工具写过的形态；遇到无法安全解析的内容抛错。 */
function readPatchEntries(text) {
  const entries = []
  const lines = text.split(/\r?\n/)
  let cur = null
  let inConfig = false
  let sawContent = false
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (line.trim() === '[]') continue
    sawContent = true
    if (/^-\s+insert:/.test(line)) throw new Error('检测到非本工具生成的 cordis.patch.yml（含 insert:），为安全起见拒绝自动编辑。请手动配置。')
    const idM = /^-\s+id:\s*([A-Za-z0-9_-]+)/.exec(line)
    if (idM) { cur = { id: idM[1], config: {} }; entries.push(cur); inConfig = false; continue }
    const cM = /^\s+config:\s*$/.exec(line)
    if (cM) { inConfig = true; continue }
    const kvM = /^\s{2,}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (kvM && cur && inConfig) { cur.config[kvM[1]] = stripQuotes(kvM[2]); continue }
    throw new Error(`无法安全解析 cordis.patch.yml 行："${line}"。请手动编辑。`)
  }
  void sawContent
  return entries
}

function stripQuotes(v) {
  const t = v.trim()
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1)
  return t
}

function renderPatch(entries) {
  let out = '# 由 @qingshanjiluo/dsh-plugin-suite 维护：以下是对各插件配置项的覆写（应用后重启 profile 生效）。\n'
  if (!entries.length) return out + '[]\n'
  for (const e of entries) {
    out += `- id: ${e.id}\n  config:\n`
    for (const [k, v] of Object.entries(e.config)) out += `    ${k}: ${coerce(v)}\n`
  }
  return out
}

function summarize(action, ok, total, failed) {
  process.stdout.write(`\n${action} 完成：${ok}/${total} 成功${failed.length ? '，失败：' + failed.join(', ') : ''}\n`)
  if (failed.length) process.exitCode = 1
}

main()
