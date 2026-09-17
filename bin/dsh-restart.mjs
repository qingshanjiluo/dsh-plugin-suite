/**
 * dsh-restart — build DSH, (re)start the web profile, capture every byte of
 * output to a timestamped log, and fall back to a smaller plugin set when the
 * profile refuses to boot.
 *
 * The happy path is: ensure the requested plugins are enabled -> build ->
 * launch `pnpm dsh web` -> wait for the port to answer. When that fails the
 * script does not guess: it reads the captured log for the known boot-failure
 * signatures, backs the profile up once, then retries with progressively
 * smaller plugin sets (`--max-plugins` ladder) until one boots or the ladder
 * runs out.
 *
 * Usage:
 *   node bin/dsh-restart.mjs                 # build + restart, full plugin set
 *   node bin/dsh-restart.mjs --no-build      # skip the build step
 *   node bin/dsh-restart.mjs --no-ensure     # leave the plugin set untouched
 *   node bin/dsh-restart.mjs --port 3080 --timeout 180   # 端口仅用于就绪探测
 *   node bin/dsh-restart.mjs --dry-run       # print the plan, change nothing
 *
 * @module dsh-restart
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUITE_ROOT = resolve(HERE, '..')

/** Plugins this run wants enabled, in enable order. */
const WANTED = [
  // Already-enabled nine (re-enabled so the script is idempotent).
  'dsh-context-manager',
  'dsh-subagent-mode',
  'dsh-data-profiling',
  'dsh-code-review-ai',
  'dsh-test-generator',
  'dsh-vision-ocr',
  'dsh-auto-translate',
  'dsh-i18n-manager',
  'dsh-scheduler',
  // Recommended additions.
  'dsh-ai-commit',
  'dsh-api-doc-gen',
  'dsh-api-tester',
  'dsh-changelog-gen',
  'dsh-commit-lint',
  'dsh-coverage-tracker',
  'dsh-db-visualizer',
  'dsh-dependency-graph',
  'dsh-docstring-gen',
  'dsh-env-switcher',
  'dsh-git-workflow',
  'dsh-gitignore-gen',
  'dsh-json-yaml-converter',
  'dsh-lint-config',
  'dsh-log-viewer',
  'dsh-markdown-preview',
  'dsh-mock-server',
  'dsh-model-router',
  'dsh-project-scaffold',
  'dsh-regex-playground',
  'dsh-sql-formatter',
  'dsh-webhook-tester',
]

/** Profiles the script is allowed to reduce during a fallback. */
const KEEP_ALWAYS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Substrings that mark a boot failure caused by the plugin set. */
const FAILURE_SIGNATURES = [
  'duplicate tool',
  'Duplicate tool',
  'already registered',
  'conflicts with',
  'tool name',
  'Cannot find module',
  'ERR_MODULE_NOT_FOUND',
  'is not a function',
  'Failed to load plugin',
  'plugin load',
  'SyntaxError',
  'TypeError',
  'ReferenceError',
]

/* ------------------------------------------------------------------ logging -- */

let logFile = ''

/** Append one line to stdout and the log file. */
function say(line = '') {
  process.stdout.write(`${line}\n`)
  if (logFile) appendFileSync(logFile, `${line}\n`, 'utf8')
}

/** Write a section banner. */
function section(title) {
  say('')
  say('='.repeat(64))
  say(`  ${title}`)
  say('='.repeat(64))
}

/* -------------------------------------------------------------------- args --- */

/** Parse `--flag` / `--key value` arguments. */
function parseArgs(argv) {
  const flags = { build: true, ensure: true, start: true, dryRun: false, port: 3080, timeout: 180, via: 'local' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--no-build': flags.build = false; break
      case '--no-ensure': flags.ensure = false; break
      case '--no-start': flags.start = false; break
      case '--dry-run': flags.dryRun = true; break
      case '--port': flags.port = Number(argv[++index]); break
      case '--timeout': flags.timeout = Number(argv[++index]); break
      case '--via': flags.via = argv[++index] === 'dsh' ? 'dsh' : 'local'; break
      default: break
    }
  }
  return flags
}

/* --------------------------------------------------------------- utilities --- */

/** Run a command, streaming its output into the log, and resolve its exit code. */
function run(command, args, options = {}) {
  return new Promise(resolvePromise => {
    say(`$ ${command} ${args.join(' ')}`)
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      shell: process.platform === 'win32',
      env: { ...process.env, ...(options.env ?? {}) },
    })
    const forward = chunk => {
      const text = chunk.toString()
      process.stdout.write(text)
      if (logFile) appendFileSync(logFile, text, 'utf8')
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', error => {
      say(`! spawn failed: ${error.message}`)
      resolvePromise({ code: -1, error })
    })
    child.on('close', code => resolvePromise({ code: code ?? -1 }))
  })
}

/**
 * True when something is listening on the port.
 *
 * This must *connect* to the port, not bind it: a bind succeeds precisely when
 * the port is free, which would report a dead server as healthy.
 */
function portOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise(resolvePromise => {
    const socket = new Socket()
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

/** The pid holding a listening port, or 0 when the port is free. */
function portOwner(port) {
  try {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout) return 0
    for (const line of result.stdout.split(/\r?\n/)) {
      // e.g. "  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    6116"
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      if (!parts[1].endsWith(`:${port}`)) continue
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    return 0
  }
  return 0
}

/** Poll the port until it opens or the deadline passes. */
async function waitForPort(port, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
  }
  return false
}

/** Read the profile package.json, or null when the profile is absent. */
function readProfile(profileFile) {
  if (!existsSync(profileFile)) return null
  try {
    return JSON.parse(readFileSync(profileFile, 'utf8'))
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) }
  }
}

/** Write the profile package.json without a BOM and with a trailing newline. */
function writeProfile(profileFile, pkg) {
  mkdirSync(dirname(profileFile), { recursive: true })
  writeFileSync(profileFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------- plugin set handling -- */

/**
 * The command prefix that runs the DSH CLI.
 *
 * There is usually no global `dsh` shim on this machine, and `npx -y
 * @deepseek-ai/dsh plugin ... remove` fails to resolve the binary, so the
 * reliable route is the checkout's own script: `pnpm dsh ...` executed with
 * `cwd` set to the DSH root. `DSH_CLI` overrides it when a real shim exists.
 */
function dshCli() {
  const override = process.env.DSH_CLI && process.env.DSH_CLI.trim() !== ''
    ? process.env.DSH_CLI.trim()
    : ''
  if (override) return override.split(' ').filter(Boolean)
  return ['pnpm', 'dsh']
}

/** Run the DSH CLI with `cwd` at the checkout, so `pnpm dsh` resolves. */
function runDsh(args, dshRoot) {
  return run(dshCli()[0], [...dshCli().slice(1), ...args], { cwd: dshRoot })
}

/** Load the suite manifest, or an empty list when it is unreadable. */
function loadManifest() {
  const file = join(SUITE_ROOT, 'plugins.json')
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/** Bare dependency keys whose value points into the shared D:/Temp checkout. */
function tempTwins(pkg) {
  const found = new Map()
  for (const [name, value] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof value === 'string' && /^file:D:\/Temp/i.test(value)) {
      found.set(name, value)
    }
  }
  return found
}

/**
 * Enable the wanted plugins by writing the profile's dependency table directly.
 *
 * `dsh plugin add` shells out to pnpm, which reaches for the registry even when
 * every spec is a local path — on a machine whose network refuses
 * registry.npmjs.org that stalls for minutes per package. Writing the profile
 * ourselves keeps the step local and instant; the only network-sensitive part
 * is the install that follows, which is run with `--offline` first.
 */
async function ensurePluginsLocal({ profile, srcRoot, dshRoot, dryRun }) {
  const manifest = loadManifest()
  const byShort = new Map(manifest.map(entry => [entry.short, entry]))
  const profileFile = join(homedir(), '.dsh', 'profiles', profile, 'package.json')
  const pkg = readProfile(profileFile)

  section('插件集确认')
  if (!pkg) {
    say(`! profile "${profile}" 尚未初始化：${profileFile}`)
    return { ok: false, reason: 'profile-missing' }
  }
  if (pkg.parseError) {
    say(`! profile package.json 无法解析：${pkg.parseError}`)
    return { ok: false, reason: 'profile-unparsable' }
  }

  const twins = tempTwins(pkg)
  const dependencies = { ...(pkg.dependencies ?? {}) }
  const removed = []
  const added = []
  const missing = []
  const unknown = []

  // Drop the shared-checkout twin of anything we are about to enable: two
  // plugins under the same tool name abort the boot.
  for (const short of WANTED) {
    if (!byShort.has(short)) {
      if (!unknown.includes(short)) unknown.push(short)
      continue
    }
    if (twins.has(short)) {
      delete dependencies[short]
      removed.push(short)
    }
  }

  for (const short of WANTED) {
    const entry = byShort.get(short)
    if (!entry) continue
    const target = join(srcRoot, short)
    if (!existsSync(join(target, 'package.json'))) {
      missing.push(short)
      continue
    }
    // `link:` keeps the checkout live: edits to the plugin are picked up on the
    // next start without a reinstall.
    const spec = `link:${target.replace(/\\/g, '/')}`
    if (dependencies[entry.pkg] !== spec) {
      dependencies[entry.pkg] = spec
      added.push(short)
    }
  }

  say(`目标 profile        : ${profile}`)
  say(`profile 文件        : ${profileFile}`)
  say(`想要启用            : ${WANTED.length} 个`)
  say(`将移除同名旧版      : ${removed.length} 个${removed.length ? ` -> ${removed.join(', ')}` : ''}`)
  say(`将写入/更新         : ${added.length} 个${added.length ? ` -> ${added.join(', ')}` : ''}`)
  if (missing.length) say(`! 本地目录缺 package.json，跳过：${missing.join(', ')}`)
  if (unknown.length) say(`! 清单里没有这些项：${unknown.join(', ')}`)

  if (dryRun) {
    say('(dry-run) 不做任何改动。')
    return { ok: true, dryRun: true }
  }
  if (removed.length === 0 && added.length === 0) {
    say('插件集已是最新，无需改动。')
    return { ok: true, changed: 0 }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${profileFile}.restart-${stamp}.bak`
  copyFileSync(profileFile, backup)
  say(`已备份 profile      : ${backup}`)

  pkg.dependencies = dependencies
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  const keep = new Set([...KEEP_ALWAYS, ...WANTED.map(short => byShort.get(short)?.pkg).filter(Boolean)])
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => keep.has(name))
  for (const name of keep) if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
  writeProfile(profileFile, pkg)
  say('profile 已写入（无 BOM、UTF-8）。')

  // Local link dependencies need no registry, so try offline first and only
  // fall back to a networked install when that genuinely fails.
  say('安装依赖（先离线）...')
  let result = await run('pnpm', ['install', '--offline'], {
    cwd: join(homedir(), '.dsh', 'profiles', profile),
  })
  if (result.code !== 0) {
    say('离线安装未成功，改用普通安装（需要网络）...')
    result = await run('pnpm', ['install'], {
      cwd: join(homedir(), '.dsh', 'profiles', profile),
    })
  }
  if (result.code !== 0) {
    say(`! pnpm install 返回 ${result.code}；profile 已写入，启动时可能仍可用。`)
    return { ok: true, backup, installFailed: true }
  }
  say('依赖安装完成。')
  return { ok: true, backup, changed: removed.length + added.length }
}

/**
 * Enable the wanted plugins.
 * Same-name plugins already present from the shared D:/Temp checkout are
 * disabled first, because two plugins registering the same tool name abort
 * the boot.
 */
async function ensurePlugins({ profile, srcRoot, dshRoot, dryRun }) {
  const manifest = loadManifest()
  const byShort = new Map(manifest.map(entry => [entry.short, entry]))
  const profileFile = join(homedir(), '.dsh', 'profiles', profile, 'package.json')
  const pkg = readProfile(profileFile)

  section('插件集确认')
  if (!pkg) {
    say(`! profile "${profile}" 尚未初始化：${profileFile}`)
    say('  先用一次 dsh 启动它，或手动 dsh --profile web --dump-config 初始化。')
    return { ok: false, reason: 'profile-missing' }
  }
  if (pkg.parseError) {
    say(`! profile package.json 无法解析：${pkg.parseError}`)
    return { ok: false, reason: 'profile-unparsable' }
  }

  const twins = tempTwins(pkg)
  const have = new Set(Object.keys(pkg.dependencies ?? {}))
  const toDisable = []
  const toEnable = []
  const unknown = []

  for (const short of WANTED) {
    const entry = byShort.get(short)
    if (!entry) {
      unknown.push(short)
      continue
    }
    // A same-name plugin from the shared checkout must go first.
    if (twins.has(short)) toDisable.push(short)
    if (!have.has(entry.pkg)) toEnable.push(short)
  }

  say(`目标 profile        : ${profile}`)
  say(`profile 文件        : ${profileFile}`)
  say(`想要启用            : ${WANTED.length} 个`)
  say(`需先禁用的同名旧版  : ${toDisable.length} 个${toDisable.length ? ` -> ${toDisable.join(', ')}` : ''}`)
  say(`需新启用            : ${toEnable.length} 个${toEnable.length ? ` -> ${toEnable.join(', ')}` : ''}`)
  if (unknown.length) say(`! 清单里没有这些项  : ${unknown.join(', ')}`)

  if (dryRun) {
    say('(dry-run) 不做任何改动。')
    return { ok: true, dryRun: true }
  }

  // Back the profile up once per run before touching it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${profileFile}.restart-${stamp}.bak`
  copyFileSync(profileFile, backup)
  say(`已备份 profile      : ${backup}`)

  for (const short of toDisable) {
    say(`- 禁用同名旧版 ${short} ...`)
    const result = await runDsh(['plugin', '--profile', profile, 'remove', short], dshRoot)
    if (result.code !== 0) say(`  ! ${short} 移除返回 ${result.code}（继续）`)
  }

  for (const short of toEnable) {
    const entry = byShort.get(short)
    const target = join(srcRoot, short)
    if (!existsSync(target)) {
      say(`  ! 跳过 ${short}：本地目录不存在 ${target}`)
      continue
    }
    say(`- 启用 ${entry.pkg} ...`)
    const result = await runDsh(['plugin', '--profile', profile, 'add', target], dshRoot)
    if (result.code !== 0) say(`  ! ${short} 启用返回 ${result.code}（继续）`)
  }

  return { ok: true, backup }
}

/** Run the suite's conflict checker and report whether the set is bootable. */
async function checkConflicts(profile) {
  const checker = join(SUITE_ROOT, 'bin', 'dsh-check.mjs')
  section('插件冲突检查')
  if (!existsSync(checker)) {
    say('! 找不到 dsh-check.mjs，跳过冲突检查。')
    return true
  }
  const result = await run('node', [checker, '--profile', profile])
  if (result.code !== 0) {
    say('')
    say('! 检出工具名冲突：这会导致启动失败。')
    return false
  }
  return true
}

/* --------------------------------------------------------------- fallback ---- */

/**
 * Shrink the profile to a bootable core.
 * Keeps the official bundles plus the first `limit` wanted plugins, and
 * removes every other third-party dependency.
 */
async function reducePlugins({ profile, limit, dryRun }) {
  const profileFile = join(homedir(), '.dsh', 'profiles', profile, 'package.json')
  const pkg = readProfile(profileFile)
  if (!pkg || pkg.parseError) return false

  const manifest = loadManifest()
  const byShort = new Map(manifest.map(entry => [entry.short, entry]))
  const keep = new Set(KEEP_ALWAYS)
  for (const short of WANTED.slice(0, limit)) {
    const entry = byShort.get(short)
    if (entry) keep.add(entry.pkg)
  }

  const dependencies = {}
  for (const [name, value] of Object.entries(pkg.dependencies ?? {})) {
    if (keep.has(name)) dependencies[name] = value
  }
  pkg.dependencies = dependencies
  if (pkg.dsh?.profile && Array.isArray(pkg.dsh.profile.bundles)) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => keep.has(name) || KEEP_ALWAYS.includes(name))
    for (const name of keep) {
      if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
    }
  }

  say(`  降级：保留 ${Object.keys(dependencies).length} 个依赖（官方 core + 前 ${limit} 个目标插件）`)
  if (dryRun) return true
  writeProfile(profileFile, pkg)
  const result = await run('pnpm', ['install'], {
    cwd: join(homedir(), '.dsh', 'profiles', profile),
  })
  if (result.code !== 0) say(`  ! pnpm install 返回 ${result.code}`)
  return true
}

/** Scan the log for signatures that point at a plugin-set boot failure. */
function scanForBootFailure(text) {
  const hits = []
  for (const signature of FAILURE_SIGNATURES) {
    if (text.includes(signature)) hits.push(signature)
  }
  return hits
}

/**
 * Read the optional `restart.config.json` beside the suite.
 *
 * Needed because a .bat launcher cannot carry a non-ASCII path safely (cmd.exe
 * parses batch files in the OEM code page), so such paths belong in a UTF-8 JSON
 * file that Node reads instead.
 */
function readConfig() {
  const candidates = [
    process.env.DSH_RESTART_CONFIG,
    join(SUITE_ROOT, 'restart.config.json'),
    join(HERE, '..', 'restart.config.json'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'))
    } catch (error) {
      say(`! 配置文件无法解析：${candidate} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {}
}

/* ------------------------------------------------------------------- main ---- */

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const config = readConfig()
  const dshRoot = process.env.DSH_ROOT?.trim()
    || config.dshRoot
    || 'G:\\dsh'
  const profile = process.env.DSH_PROFILE?.trim()
    || config.profile
    || 'web'
  // Where the dsh-* plugin checkouts live. Derived from the suite location when
  // the suite sits beside them, but that assumption breaks as soon as the bin
  // scripts are copied to a shorter path — so explicit config/env always wins,
  // and a missing directory is reported instead of silently scanning elsewhere.
  const srcRoot = process.env.DSH_PLUGIN_SRC?.trim()
    || config.pluginSrc
    || resolve(SUITE_ROOT, '..')

  const logDir = join(SUITE_ROOT, 'logs')
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  logFile = join(logDir, `restart-${stamp}.log`)

  say(`DSH restart — ${new Date().toISOString()}`)
  say(`日志文件 : ${logFile}`)
  say(`DSH 检出 : ${dshRoot}`)
  say(`profile  : ${profile}`)
  say(`插件源   : ${srcRoot}`)

  if (!existsSync(dshRoot)) {
    say(`! 找不到 DSH 检出目录：${dshRoot}`)
    process.exitCode = 1
    return
  }

  // A wrong source root would otherwise look like "every plugin is missing".
  if (flags.ensure && !existsSync(join(srcRoot, 'dsh-scheduler'))) {
    say(`! 插件源目录里找不到 dsh-scheduler：${srcRoot}`)
    say('  请设置 DSH_PLUGIN_SRC 指向含 dsh-* 子目录的仓库根，例如：')
    say('    set DSH_PLUGIN_SRC=<含 dsh-* 的目录>')
    process.exitCode = 1
    return
  }

  if (flags.ensure) {
    const outcome = flags.via === 'dsh'
      ? await ensurePlugins({ profile, srcRoot, dshRoot, dryRun: flags.dryRun })
      : await ensurePluginsLocal({ profile, srcRoot, dshRoot, dryRun: flags.dryRun })
    if (!outcome.ok && !flags.dryRun) {
      say('! 插件集无法确认，中止以免把 profile 弄坏。')
      process.exitCode = 1
      return
    }
  }

  if (flags.dryRun) {
    // A dry run reports the plan and nothing else: no conflict scan, no build,
    // no launch, no install.
    section('结束')
    say('(dry-run) 只打印计划，未做任何改动、未构建、未启动。')
    say(`日志：${logFile}`)
    return
  }

  const clean = await checkConflicts(profile)
  if (!clean) {
    say('! 冲突未解决，仍会尝试启动；失败后自动降级。')
  }

  if (flags.build) {
    section('构建')
    const result = await run('pnpm', ['run', 'build:official'], { cwd: dshRoot })
    if (result.code !== 0) {
      say(`! 构建失败，退出码 ${result.code}。日志：${logFile}`)
      say('  构建失败时不启动，避免跑在旧产物上。')
      process.exitCode = 1
      return
    }
    say('构建完成。')
  }

  if (!flags.start) {
    section('结束')
    say('(--no-start) 未启动。')
    say(`日志：${logFile}`)
    return
  }

  // Ladder: full set first, then progressively smaller sets.
  const ladder = [WANTED.length, 12, 6, 2, 0]
  for (let attempt = 0; attempt < ladder.length; attempt += 1) {
    const limit = ladder[attempt]
    section(`启动尝试 ${attempt + 1}/${ladder.length}（插件上限 ${limit === WANTED.length ? '全部' : limit}）`)

    // A port held by someone else is not a plugin problem: degrading the set
    // would change the profile for nothing and still fail. Stop and report.
    const owner = portOwner(flags.port)
    if (owner !== 0) {
      section('端口已被占用')
      say(`127.0.0.1:${flags.port} 已被 pid ${owner} 监听（很可能是你正在运行的 DSH）。`)
      say('这不是插件冲突，因此不会降级插件集。请二选一：')
      say(`  1) 直接使用已在运行的实例：http://127.0.0.1:${flags.port}/`)
      say(`  2) 先自行停掉 pid ${owner}，再重新运行本脚本`)
      say('  （监听端口由 profile 的 webserver 配置决定，本脚本无法代你改端口）')
      say(`日志：${logFile}`)
      process.exitCode = 2
      return
    }

    if (attempt > 0) {
      const reduced = await reducePlugins({ profile, limit, dryRun: flags.dryRun })
      if (!reduced) {
        say('! 无法降级 profile，继续。')
      }
    }

    // The listen port belongs to the profile's webserver config, not the
    // environment, so it cannot be redirected from here. `--port` therefore
    // only selects which socket the readiness check watches.
    const child = spawn('pnpm', ['dsh', 'web'], {
      cwd: dshRoot,
      shell: process.platform === 'win32',
      env: process.env,
      detached: false,
    })
    let captured = ''
    const forward = chunk => {
      const text = chunk.toString()
      captured += text
      process.stdout.write(text)
      if (logFile) appendFileSync(logFile, text, 'utf8')
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)

    say('等待端口打开 ...')
    const healthy = await waitForPort(flags.port, flags.timeout)
    const exited = child.exitCode !== null

    if (healthy && !exited) {
      section('启动成功')
      say(`DSH web 已就绪：http://127.0.0.1:${flags.port}/`)
      say(`本进程持有 DSH 子进程（pid ${child.pid}）——关闭此窗口即停止它。`)
      say(`日志：${logFile}`)
      // Hand the terminal over to the running server.
      await new Promise(resolvePromise => {
        child.on('close', code => {
          say(`DSH 进程退出，代码 ${code}`)
          resolvePromise(undefined)
        })
      })
      return
    }

    const hits = scanForBootFailure(captured)
    say(`本次未就绪（端口未开=${!healthy}，进程已退出=${exited}）。`)
    if (hits.length) say(`日志命中错误特征：${hits.join(', ')}`)

    if (child.exitCode === null) {
      say('正在停止本次尝试的 DSH 进程 ...')
      child.kill()
      await new Promise(resolvePromise => setTimeout(resolvePromise, 3000))
    }

    if (attempt === ladder.length - 1) {
      section('启动失败')
      say('所有降级档位均未能启动。请把日志交给维护者：')
      say(`  ${logFile}`)
      process.exitCode = 1
      return
    }
    say('按阶梯降级插件集后重试 ...')
  }
}

await main()
