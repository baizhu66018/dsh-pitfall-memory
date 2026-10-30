/**
 * 把本插件安装进一个 DSH profile。
 *
 * 做两件事（都幂等）：
 * 1. 把包复制到 <profile>/node_modules/<包名>；
 * 2. 把包名加进 <profile>/package.json 的 dsh.profile.bundles（这才是真正挂载它的地方）。
 *
 * 包的 bundle 补丁（cordis.patch.yml）会由 DSH 在加载 bundle 时自动应用，
 * 因此不需要手改 profile 的 cordis.patch.yml。
 *
 * 用法：
 *   node scripts/install.mjs --dry-run
 *   node scripts/install.mjs
 *   node scripts/install.mjs --profile desktop --home "$DSH_HOME"
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function argValue(flag) {
  const index = process.argv.indexOf(`--${flag}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const dryRun = process.argv.includes('--dry-run')
const profile = argValue('profile') ?? 'desktop'
const home = argValue('home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const manifestPath = path.join(profileDir, 'package.json')
const dest = path.join(profileDir, 'node_modules', pkg.name)

process.stdout.write(`package:  ${pkg.name}@${pkg.version}\n`)
process.stdout.write(`source:   ${root}\n`)
process.stdout.write(`profile:  ${profileDir}\n`)
process.stdout.write(`mode:     ${dryRun ? 'dry run' : 'install'}\n\n`)

if (!fs.existsSync(manifestPath)) {
  process.stderr.write(`找不到 profile 清单：${manifestPath}\n`)
  process.stderr.write('用 --profile <名字> 或 --home <DSH_HOME> 指向正确的安装。\n')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : []
const mounted = bundles.includes(pkg.name)
const copied = fs.existsSync(dest)

process.stdout.write(`${mounted ? '=' : '+'} bundles: ${bundles.length} 项${mounted ? '（已包含）' : ''}\n`)
process.stdout.write(`${copied ? '~' : '+'} files:   ${dest}${copied ? '（将覆盖）' : ''}\n`)

if (!mounted) {
  bundles.push(pkg.name)
  process.stdout.write(`  新的 bundles: ${bundles.join(', ')}\n`)
}

if (dryRun) {
  process.stdout.write('\ndry run：没有写任何文件。\n')
  process.exit(0)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.cpSync(root, dest, {
  recursive: true,
  filter: (source) => {
    const name = path.basename(source)
    if (name === 'node_modules' || name === '.git' || name === '.test-tmp') return false
    if (name.startsWith('package.json.bak-')) return false
    return true
  },
})
process.stdout.write(`复制完成 -> ${dest}\n`)

if (!mounted) {
  const backup = `${manifestPath}.bak-${Date.now()}`
  fs.copyFileSync(manifestPath, backup)
  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: { ...(manifest.dsh?.profile ?? {}), bundles },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`挂载完成 -> ${manifestPath}（备份：${path.basename(backup)}）\n`)
}

process.stdout.write(
  '\n下一步：重启 DSH（或让 profile 监听器重新加载 bundle）。\n'
    + '之后每次会话的失败会被自动记录到 <profile>/.dsh-pitfall-memory/，\n'
    + '下一次会话开始时自动注入。\n',
)