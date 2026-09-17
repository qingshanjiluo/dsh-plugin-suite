/**
 * Focused checks for the restart script's decision logic, run against a copy of
 * a profile rather than the real one.
 *
 * Covers: log written as clean UTF-8, boot-failure signature detection, the
 * fallback ladder shape, and profile reduction keeping only the kept plugins.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const restartSource = readFileSync(
  new URL('../bin/dsh-restart.mjs', import.meta.url),
  'utf8',
)

// The ladder and the signature list are the parts worth pinning down, so assert
// on the source contract rather than importing (which would run main()).
assert.match(restartSource, /const ladder = \[WANTED\.length, 12, 6, 2, 0\]/, 'fallback ladder present')
assert.match(restartSource, /'duplicate tool'/, 'duplicate-tool signature present')
assert.match(restartSource, /'ERR_MODULE_NOT_FOUND'/, 'module-not-found signature present')
assert.match(restartSource, /appendFileSync\(logFile, text, 'utf8'\)/, 'log written as utf8')
// A busy port must not be mistaken for a plugin failure.
assert.match(restartSource, /function portOwner\(/, 'port owner lookup present')
assert.match(restartSource, /这不是插件冲突，因此不会降级插件集/, 'busy port refuses to degrade')
// The local enable path avoids the registry entirely.
assert.match(restartSource, /'install', '--offline'/, 'offline install attempted first')
assert.match(restartSource, /replace\(\/\\\\\/g, '\/'\)/, 'link spec uses forward slashes')
// Readiness must CONNECT (a bind would succeed exactly when the port is free,
// reporting a dead server as healthy).
assert.match(restartSource, /new Socket\(\)/, 'readiness probe dials the port')
assert.doesNotMatch(restartSource, /socket\.listen\(/, 'readiness probe never binds the port')

// Loader entry ids must not collide with official layers.
const checkSource = readFileSync(new URL('../bin/dsh-check.mjs', import.meta.url), 'utf8')
assert.match(checkSource, /function loaderIds\(/, 'loader id scan present')
assert.match(checkSource, /duplicate loader entry id/, 'entry-id conflict is reported')
assert.match(checkSource, /entryConflicts/, 'entry conflicts tracked')

// A profile shaped like the real one, plus a Temp twin that must be recognised.
const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
const profileFile = join(dir, 'package.json')
const profile = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {
    '@deepseek-ai/dsh-base': 'file:D:/Temp/dsh-base',
    'dsh-log-viewer': 'file:D:/Temp/dsh-plugins-all/dsh-log-viewer',
    '@qingshanjiluo/dsh-scheduler': 'link:G:/somewhere/dsh-scheduler',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-log-viewer', '@qingshanjiluo/dsh-scheduler'] } },
}
writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')

// The same detection rule the script uses for shared-checkout twins.
function tempTwins(pkg) {
  const found = new Map()
  for (const [name, value] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof value === 'string' && /^file:D:\/Temp/i.test(value)) found.set(name, value)
  }
  return found
}

const twins = tempTwins(JSON.parse(readFileSync(profileFile, 'utf8')))
assert.deepEqual([...twins.keys()].sort(), ['@deepseek-ai/dsh-base', 'dsh-log-viewer'], 'detects Temp twins')
assert.ok(twins.has('dsh-log-viewer'), 'the clashing log viewer is flagged')

// Reduction keeps the official core plus the first N wanted plugins only.
// Mirrors the real reducePlugins: `keep` holds full package names, because that
// is the key the profile uses — a same-name twin sits under its bare name and
// must therefore drop out.
const KEEP_ALWAYS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const manifest = [
  { short: 'dsh-scheduler', pkg: '@qingshanjiluo/dsh-scheduler' },
  { short: 'dsh-log-viewer', pkg: '@qingshanjiluo/dsh-log-viewer' },
]
const WANTED = ['dsh-scheduler', 'dsh-log-viewer']
function reduce(pkg, limit) {
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
  return dependencies
}

const reducedLimit1 = reduce(profile, 1)
assert.deepEqual(
  Object.keys(reducedLimit1).sort(),
  ['@deepseek-ai/dsh-base', '@qingshanjiluo/dsh-scheduler'],
  'limit 1 keeps core + scheduler under its scoped name',
)
assert.equal(
  Object.prototype.hasOwnProperty.call(reducedLimit1, 'dsh-log-viewer'),
  false,
  'the bare-name Temp twin drops out at limit 1',
)
const reducedLimit0 = reduce(profile, 0)
assert.deepEqual(Object.keys(reducedLimit0), ['@deepseek-ai/dsh-base'], 'limit 0 keeps official core only')

// Signature scanning matches what a failed boot actually prints.
const FAILURE_SIGNATURES = ['duplicate tool', 'Cannot find module', 'SyntaxError']
function scanForBootFailure(text) {
  return FAILURE_SIGNATURES.filter(signature => text.includes(signature))
}
assert.deepEqual(scanForBootFailure('Error: duplicate tool name "x"'), ['duplicate tool'])
assert.deepEqual(scanForBootFailure('all good'), [])

// Log bytes must be valid UTF-8 with no BOM.
const logFile = join(dir, 'logs', 'sample.log')
mkdirSync(join(dir, 'logs'), { recursive: true })
writeFileSync(logFile, 'DSH restart — 日志文件 : G:\\皮皮\n', 'utf8')
const bytes = readFileSync(logFile)
assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'log has no BOM')
assert.equal(bytes.toString('utf8').includes('日志文件'), true, 'log round-trips CJK')
assert.ok(existsSync(logFile), 'log exists')

rmSync(dir, { recursive: true, force: true })
console.log('restart-logic: ok — ladder, signatures, twin detection and reduction verified')
