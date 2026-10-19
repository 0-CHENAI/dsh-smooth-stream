#!/usr/bin/env node
/**
 * Cut a release: bump package.json, rebuild lib/, gate on typecheck + tests,
 * then commit, tag and push. Pushing the vX.Y.Z tag is what makes
 * .github/workflows/publish.yml publish to npm, and that workflow refuses any
 * tag that does not equal `v${package.json.version}` — so every publish needs
 * a fresh version and a matching fresh tag. This script is the only supported
 * way to produce that pair.
 *
 * Usage: pnpm release <patch|minor|major|prerelease|x.y.z[-pre]>
 *
 * Options:
 *   --preid <id>      prerelease identifier for `prerelease` bumps (default: rc)
 *   --dry-run         run every check, print the plan, change nothing
 *   --yes             skip the confirmation prompt (required without a TTY)
 *   --no-push         stop after the local commit and tag
 *   --skip-checks     skip the local build/typecheck/test gate (not advised)
 *   --skip-npm-check  skip the registry lookup for an already published version
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_NAME = '@laufry/dsh-smooth-stream'
const EXPECTED_REPO = 'github.com/0-CHENAI/dsh-smooth-stream'
const REGISTRY_URL = 'https://registry.npmjs.org/@laufry%2Fdsh-smooth-stream'

const PREID_PATTERN = /^[0-9A-Za-z-]+$/

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function usage() {
  console.log(`用法: pnpm release <patch|minor|major|prerelease|x.y.z[-pre]> [选项]

选项:
  --preid <id>       prerelease 递增时使用的标识（默认 rc）
  --dry-run          只执行检查并打印计划，不做任何改动
  --yes              跳过确认提示（非交互环境必须加）
  --no-push          只做本地提交和打 tag，不推送
  --skip-checks      跳过本地 build/typecheck/test 闸门（不建议）
  --skip-npm-check   跳过 npm registry 的重复版本查询

示例:
  pnpm release prerelease            # 0.8.0-rc.1 -> 0.8.0-rc.2
  pnpm release 0.8.0                 # 正式版，发到 dist-tag latest
  pnpm release 0.8.0-rc.2 --dry-run  # 先看检查结果`)
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease.length > 0 ? `${base}-${version.prerelease.join('.')}` : base
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right)
      if (delta !== 0) return delta
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

function resolveNextVersion(current, target, preid) {
  const parsed = parseVersion(target)
  if (parsed !== null) {
    if (compareVersions(parsed, current) <= 0) {
      fail(`目标版本 ${target} 必须高于当前版本 ${formatVersion(current)}`)
    }
    return parsed
  }

  const keywords = new Set(['patch', 'minor', 'major', 'prerelease'])
  if (!keywords.has(target)) {
    fail(`无法识别的版本参数 ${target}；支持 patch|minor|major|prerelease 或显式 x.y.z[-pre]`)
  }

  const { major, minor, patch, prerelease } = current
  if (target === 'major') {
    return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  }
  if (target === 'minor') {
    return { major, minor: minor + 1, patch: 0, prerelease: [] }
  }
  if (target === 'patch') {
    // semver 语义：有预发布时 patch 递增只丢预发布，0.8.0-rc.1 -> 0.8.0。
    return { major, minor, patch: prerelease.length > 0 ? patch : patch + 1, prerelease: [] }
  }

  if (prerelease.length === 0) {
    return { major, minor, patch: patch + 1, prerelease: [preid, '0'] }
  }
  if (prerelease[0] !== preid) {
    return { major, minor, patch, prerelease: [preid, '0'] }
  }
  const identifiers = [...prerelease]
  let numericIndex = identifiers.length - 1
  while (numericIndex >= 0 && !/^\d+$/.test(identifiers[numericIndex])) numericIndex -= 1
  if (numericIndex < 0) {
    identifiers.push('0')
  } else {
    identifiers[numericIndex] = String(Number(identifiers[numericIndex]) + 1)
  }
  return { major, minor, patch, prerelease: identifiers }
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.error) fail(`git ${args.join(' ')} 无法执行: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    fail(`git ${args.join(' ')} 失败:\n${(result.stderr || result.stdout || '').trim()}`)
  }
  return result
}

function gitOutput(args) {
  return git(args).stdout.trim()
}

function run(label, command, args) {
  console.log(`\n▸ ${label}`)
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env })
  if (result.error) fail(`无法执行 ${command}: ${result.error.message}`)
  return result.status === 0
}

async function assertNotPublished(version) {
  let response
  try {
    response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
  } catch (error) {
    fail(`访问 npm registry 失败（${error.message}）；确认网络后重试，或加 --skip-npm-check`)
  }
  if (response.status === 404) return
  if (!response.ok) fail(`npm registry 返回 HTTP ${response.status}`)
  const data = await response.json()
  if (data.versions && Object.hasOwn(data.versions, version)) {
    fail(`npm 上已存在 ${EXPECTED_NAME}@${version}；请换一个更高的版本号`)
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    fail('非交互环境无法确认，请加 --yes')
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await reader.question(`${question} `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    reader.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const options = { preid: 'rc', dryRun: false, yes: false, noPush: false, skipChecks: false, skipNpmCheck: false, target: '' }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--no-push') options.noPush = true
    else if (arg === '--skip-checks') options.skipChecks = true
    else if (arg === '--skip-npm-check') options.skipNpmCheck = true
    else if (arg.startsWith('--preid=')) options.preid = arg.slice('--preid='.length)
    else if (arg === '--preid') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) fail('--preid 需要取值，例如 --preid rc')
      options.preid = value
      index += 1
    } else if (arg.startsWith('-')) fail(`未知参数 ${arg}（--help 查看用法）`)
    else if (options.target === '') options.target = arg
    else fail(`只接受一个版本参数，收到多余的 ${arg}`)
  }

  if (options.target === '') {
    usage()
    fail('缺少版本参数')
  }
  if (!PREID_PATTERN.test(options.preid)) fail(`--preid 取值不合法: ${options.preid}`)

  const packagePath = resolve(REPO_ROOT, 'package.json')
  const rawPackage = readFileSync(packagePath, 'utf8')
  const pkg = JSON.parse(rawPackage)

  if (pkg.name !== EXPECTED_NAME) fail(`package.json name 是 ${pkg.name}，不是 ${EXPECTED_NAME}`)
  const repository = typeof pkg.repository === 'string' ? pkg.repository : String(pkg.repository?.url ?? '')
  if (!repository.includes(EXPECTED_REPO)) fail(`package.json repository 必须指向 ${EXPECTED_REPO}`)

  const current = parseVersion(pkg.version)
  if (current === null) fail(`package.json 当前版本无法解析: ${pkg.version}`)
  const next = resolveNextVersion(current, options.target, options.preid)
  const nextText = formatVersion(next)
  const tag = `v${nextText}`
  const distTag = next.prerelease.length > 0 ? 'next' : 'latest'
  const commitMessage = `chore: release ${tag}`

  console.log(`\n▸ 预检`)
  console.log(`  当前版本  ${pkg.version}`)
  console.log(`  目标版本  ${nextText}`)
  console.log(`  npm tag   ${distTag}`)
  console.log(`  git tag   ${tag}`)

  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') fail(`当前分支是 ${branch}，发布必须在 main 上进行`)

  const dirty = gitOutput(['status', '--porcelain'])
  if (dirty !== '') fail(`工作区不干净，先提交或清理：\n${dirty}`)

  const originUrl = gitOutput(['remote', 'get-url', 'origin'])
  if (!originUrl.includes(EXPECTED_REPO)) fail(`origin 指向 ${originUrl}，不是 ${EXPECTED_REPO}`)

  git(['fetch', 'origin', '--tags', '--prune', '--quiet'])
  const head = gitOutput(['rev-parse', 'HEAD'])
  const remoteHead = gitOutput(['rev-parse', 'origin/main'])
  if (head !== remoteHead) {
    fail('本地 main 与 origin/main 不一致；先对齐再发布（本地 commit 未推送时手动 push，落后时先 pull）')
  }

  if (git(['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    fail(`本地已存在 tag ${tag}`)
  }
  if (gitOutput(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]) !== '') {
    fail(`远程已存在 tag ${tag}`)
  }
  console.log('  ✓ 分支、工作区、远端同步、tag 唯一性通过')

  if (!options.skipNpmCheck) {
    await assertNotPublished(nextText)
    console.log('  ✓ npm 上不存在该版本')
  }

  console.log(`\n计划：写入 package.json → 重建 lib → typecheck + test → 提交 "${commitMessage}" → 打 tag ${tag}${options.noPush ? '' : ' → 推送 main 与 tag'}，推送后由 GitHub Actions 自动发布到 npm（dist-tag ${distTag}）。`)

  if (options.dryRun) {
    console.log('\n--dry-run：到此为止，未做任何改动。')
    return
  }

  if (!options.yes) {
    const confirmed = await confirm(`继续发布 ${pkg.name}@${nextText}？(y/N)`)
    if (!confirmed) fail('已取消，未做任何改动')
  }

  writeFileSync(packagePath, `${JSON.stringify({ ...pkg, version: nextText }, null, 2)}\n`)
  console.log(`\n▸ package.json 版本已改为 ${nextText}`)

  if (!options.skipChecks) {
    const checksPassed = run('重建 lib（pnpm build）', 'pnpm', ['build'])
      && run('类型检查（pnpm typecheck）', 'pnpm', ['typecheck'])
      && run('测试（pnpm test）', 'pnpm', ['test'])
    if (!checksPassed) {
      git(['checkout', '--', 'package.json'], { allowFailure: true })
      fail('本地校验失败，已恢复 package.json；没有提交、打 tag 或推送')
    }
  } else {
    console.log('\n▸ 已按 --skip-checks 跳过 build/typecheck/test')
  }

  git(['add', '--all'])
  const staged = gitOutput(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
  if (!staged.includes('package.json')) fail('package.json 没有变更，中止（未提交）')
  const unexpected = staged.filter(file => file !== 'package.json' && !file.startsWith('lib/'))
  if (unexpected.length > 0) {
    fail(`预期之外的改动进入暂存区：${unexpected.join(', ')}；未提交，请检查`)
  }

  git(['commit', '-m', commitMessage])
  git(['tag', '-a', tag, '-m', tag])
  console.log(`\n▸ 已提交 ${commitMessage} 并打 tag ${tag}`)

  if (options.noPush) {
    console.log(`\n--no-push：尚未推送。确认无误后执行：\n  git push origin main\n  git push origin ${tag}`)
    return
  }

  git(['push', 'origin', 'main'])
  git(['push', 'origin', tag])
  console.log(`
✓ ${EXPECTED_NAME}@${nextText} 已推送，tag ${tag} 会触发发布工作流：
  https://github.com/0-CHENAI/dsh-smooth-stream/actions/workflows/publish.yml

稍等 1-2 分钟后核对：
  npm view ${EXPECTED_NAME} dist-tags --json`)
}

export { compareVersions, formatVersion, parseVersion, resolveNextVersion }

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch(error => {
    fail(error instanceof Error ? error.message : String(error))
  })
}
