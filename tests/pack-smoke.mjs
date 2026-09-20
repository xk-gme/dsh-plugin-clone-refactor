/**
 * The packaged artefact must contain exactly what the plugin needs at runtime:
 * `lib/index.js` plus the patch layer. A missing patch file means a marketplace
 * install that silently does nothing, and a packed entry point that does not
 * load is the same class of failure.
 *
 * The READMEs are deliberately NOT asserted here: Task 15 creates them, and
 * asserting a file that does not exist yet would fail this task for a reason
 * this task cannot fix. Task 15 extends this list once they exist.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
// `npm pack` runs this package's own `prepack`/`prepare` (tsdown), and those
// scripts share npm's stdout, so the capture is "build log + JSON report" and
// never plain JSON. The report is the LAST thing npm writes, so scan from the
// END and take the first candidate that actually parses: a stray `[` line
// earlier in the build log must not turn a healthy package into a red gate.
const lines = raw.split(/\r?\n/)
let report
for (let index = lines.length - 1; index >= 0 && report === undefined; index -= 1) {
  if (!lines[index].trimStart().startsWith('[')) continue
  try {
    const parsed = JSON.parse(lines.slice(index).join('\n'))
    if (Array.isArray(parsed)) report = parsed
  } catch {
    // A `[` from the build log rather than the report. Keep scanning backwards.
  }
}
if (report === undefined) throw new Error(`npm pack --json wrote no parseable JSON report:\n${raw}`)
const [entry] = report
const files = entry.files.map(file => file.path.replaceAll('\\', '/'))
for (const required of ['lib/index.js', 'cordis.patch.yml', 'LICENSE']) {
  if (!files.includes(required)) throw new Error(`the packaged artefact is missing ${required}`)
}
if (files.some(file => file.startsWith('docs/superpowers/'))) throw new Error('internal design docs must not be published')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must point at the committed patch layer')

// The file LIST is not the whole contract: `main` could name something the pack
// never includes, or the packed entry could fail to load. Both install silently.
// `pnpm run verify` runs this after `build`, and `npm pack` rebuilds through its
// `prepack` hook anyway, so the file this names exists on disk at this point.
const main = typeof manifest.main === 'string' ? manifest.main : ''
if (main === '') throw new Error('package.json must name a main entry point')
const exported = manifest.exports?.['.']
if (typeof exported !== 'string') {
  throw new Error(`package.json exports['.'] must be the string naming the entry point, got ${JSON.stringify(exported)}`)
}
const normalize = value => value.replace(/^\.\//, '').replaceAll('\\', '/')
if (normalize(exported) !== normalize(main)) throw new Error(`exports['.'] (${exported}) must agree with main (${main})`)
if (!files.includes(normalize(main))) throw new Error(`the packaged artefact is missing its entry point ${main}`)
try {
  await import(pathToFileURL(resolve(normalize(main))).href)
} catch (error) {
  throw new Error(`the packed entry point ${main} does not import: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(`pack-smoke: ${files.length} file(s) verified, ${normalize(main)} imports`)
