// Dev-only setup: resolve the DeepSeek Harness packages from a local checkout.
//
// The emitted bundle imports nothing at runtime -- every `@deepseek-ai/*`
// specifier in src/index.ts is `import type` and is erased. Those packages are
// needed in two places only: to typecheck the source (their `lib/types`), and
// to compose the real harness inside the tests. Most of them are not on the
// public registry, so a package manager cannot fetch them for us; point this
// script at a checkout instead. Nothing is copied into or written to that
// checkout -- the links live in this project's own (gitignored) node_modules.
//
//   npm run link-dsh -- <path-to-dsh-checkout>
//   DSH_CHECKOUT=/path/to/checkout npm run link-dsh
//
// With no argument, the single sibling checkout is used; when several sit side
// by side the script stops and lists them rather than guessing a version.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(project, 'node_modules')
const isWindows = process.platform === 'win32'

/** Package groups inside a checkout, in link order. */
const GROUPS = ['packages', 'vendor']

/** Dev tools the npm scripts reach for by file; borrowed when not installed. */
const TOOLS = ['typescript', 'vitest']

// Two layouts that only a harness checkout has; either is enough.
const isCheckout = (dir) => existsSync(join(dir, 'packages'))
  && (existsSync(join(dir, 'packages', 'core', 'agent', 'package.json'))
    || existsSync(join(dir, 'apps', 'cli', 'package.json')))

function candidates() {
  const parent = resolve(project, '..')
  return readdirSync(parent).filter((name) => isCheckout(join(parent, name))).map((name) => join(parent, name))
}

function findCheckout() {
  const explicit = process.argv[2] ?? process.env.DSH_CHECKOUT
  if (explicit) return resolve(explicit)
  const found = candidates()
  // Several checkouts side by side usually means several versions, and picking
  // one silently would build and test against a tree nobody chose.
  if (found.length > 1) {
    console.error('link-checkout: several harness checkouts sit next to this project:')
    for (const dir of found) console.error('  ' + dir + '  (version ' + checkoutVersion(dir) + ')')
    console.error('choose one:  npm run link-dsh -- <path-to-dsh-checkout>')
    process.exit(1)
  }
  return found[0]
}

/** The root manifest version of a checkout, for messages only. */
function checkoutVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Every package directory under the checkout's groups that declares a name. */
async function collectPackages(checkout) {
  const found = new Map()
  for (const group of GROUPS) {
    const base = join(checkout, group)
    if (!existsSync(base)) continue
    const queue = [[base, 0]]
    while (queue.length) {
      const [dir, depth] = queue.pop()
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        try {
          const { name } = JSON.parse(await readFile(manifest, 'utf8'))
          if (typeof name === 'string' && !found.has(name)) found.set(name, dir)
        } catch {
          // A package.json that will not parse does not name a package.
        }
      }
      if (depth >= 3) continue
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
          queue.push([join(dir, entry.name), depth + 1])
        }
      }
    }
  }
  return found
}

// Remove a link without walking through it: a non-recursive rm cannot follow a
// junction into the checkout and delete real files there. The recursive form is
// only reached for a plain directory that is not a link at all.
async function drop(path) {
  try {
    await rm(path, { force: true })
  } catch {
    await rm(path, { recursive: true, force: true })
  }
}

async function link(name, target, stats) {
  const at = join(modules, ...name.split('/'))
  await mkdir(dirname(at), { recursive: true })
  const real = await realpath(target)
  if (await realpath(at).catch(() => undefined) === real) {
    stats.unchanged++
    return
  }
  if (await isLink(at)) await drop(at)
  await symlink(real, at, isWindows ? 'junction' : 'dir')
  stats.linked++
}

async function isLink(path) {
  const info = await lstat(path).catch(() => undefined)
  return !!info && info.isSymbolicLink()
}

/** The harness checkout a path lives under, if any. */
async function checkoutOf(path) {
  let dir = resolve(path)
  for (let up = 0; up < 6; up++) {
    const parent = dirname(dir)
    if (parent === dir) break
    if (isCheckout(parent)) return parent
    dir = parent
  }
  return undefined
}

// Drop links an earlier run made to a *different* checkout: half a node_modules
// pointing at another harness version silently builds and tests the wrong tree.
// The candidates are exactly the paths `link` writes -- scoped package entries
// and the tool entries themselves. Nothing deeper is ever examined, because one
// level down we are inside whatever the link points at, and deleting that would
// edit the tree on the other side of the link. Real directories are skipped:
// they belong to an install, not to this script.
async function prune(keep, stats) {
  if (!existsSync(modules)) return
  const paths = TOOLS.map((tool) => join(modules, tool))
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.name.startsWith('@') || entry.name.startsWith('.')) continue
    const scope = join(modules, entry.name)
    if (!existsSync(scope)) continue
    for (const pkg of await readdir(scope, { withFileTypes: true })) paths.push(join(scope, pkg.name))
  }
  for (const at of paths) {
    if (!await isLink(at)) continue
    const real = await realpath(at).catch(() => undefined)
    if (!real) continue
    const from = await checkoutOf(real)
    if (from && resolve(from) !== resolve(keep)) {
      await drop(at)
      stats.pruned.push(`${basename(at)} (was ${from})`)
    }
  }
}

const checkout = findCheckout()
if (!checkout || !isCheckout(checkout)) {
  console.error('link-checkout: no DeepSeek Harness checkout found.')
  console.error('  pass one:      npm run link-dsh -- <path-to-dsh-checkout>')
  console.error('  or in the env: DSH_CHECKOUT=<path-to-dsh-checkout>')
  console.error('  a checkout is the directory holding apps/cli and packages/core/agent')
  process.exit(1)
}

const stats = { linked: 0, unchanged: 0, pruned: [] }
await prune(checkout, stats)
const packages = await collectPackages(checkout)
for (const [name, dir] of packages) await link(name, dir, stats)

// The build needs the compiler and the tests need a runner. An installed dev
// dependency wins; borrow the checkout's only when this project has none of its
// own. The npm scripts call these by file rather than by bin shim, so a borrowed
// (linked) copy behaves exactly like an installed one.
for (const tool of TOOLS) {
  if (existsSync(join(modules, tool))) continue
  const borrowed = join(checkout, 'node_modules', tool)
  if (existsSync(borrowed)) await link(tool, borrowed, stats)
  else console.warn(`link-checkout: no ${tool} in this project or in ${checkout}/node_modules; run npm install`)
}

// Typechecking this plugin reads node globals (fetch, Headers, Request) and
// node:async_hooks, so @types/node is borrowed the same way. It lives under a
// scope directory, which the loop above never walks into.
if (!existsSync(join(modules, '@types', 'node'))) {
  const borrowed = join(checkout, 'node_modules', '@types', 'node')
  if (existsSync(borrowed)) await link('@types/node', borrowed, stats)
  else console.warn('link-checkout: no @types/node to borrow; run npm install')
}

console.log(`link-checkout: checkout ${checkout} (version ${checkoutVersion(checkout)})`)
console.log(`link-checkout: ${packages.size} package directories, ${stats.linked} linked, ${stats.unchanged} already linked`)
if (stats.pruned.length) {
  console.log(`link-checkout: pruned ${stats.pruned.length} link(s) pointing at another checkout:`)
  for (const line of stats.pruned) console.log('  ' + line)
}
