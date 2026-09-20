/**
 * The packaged artefact must contain exactly what the plugin needs at runtime:
 * `lib/index.js` plus the patch layer. A missing patch file means a marketplace
 * install that silently does nothing.
 *
 * The READMEs are deliberately NOT asserted here: Task 15 creates them, and
 * asserting a file that does not exist yet would fail this task for a reason
 * this task cannot fix. Task 15 extends this list once they exist.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
// `npm pack` runs this package's own `prepack`/`prepare` (tsdown), and those
// scripts share npm's stdout, so the capture is "build log + JSON report" and
// never plain JSON. The report is the last JSON document npm writes: start at
// the opening bracket on its own line rather than at byte 0.
const lines = raw.split(/\r?\n/)
const report = lines.indexOf('[')
if (report === -1) throw new Error(`npm pack --json wrote no JSON report:\n${raw}`)
const [entry] = JSON.parse(lines.slice(report).join('\n'))
const files = entry.files.map(file => file.path.replaceAll('\\', '/'))
for (const required of ['lib/index.js', 'cordis.patch.yml', 'LICENSE']) {
  if (!files.includes(required)) throw new Error(`the packaged artefact is missing ${required}`)
}
if (files.some(file => file.startsWith('docs/superpowers/'))) throw new Error('internal design docs must not be published')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must point at the committed patch layer')
console.log(`pack-smoke: ${files.length} file(s) verified`)
