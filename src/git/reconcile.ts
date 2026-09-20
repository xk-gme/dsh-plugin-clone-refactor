/**
 * The authorization check: what git says changed versus what the ledger says the
 * user allowed. A mismatch freezes the run — the plugin cannot stop an edit, but
 * it can refuse to verify or submit one it never authorized.
 */
import { normalizePath } from '../core/paths.ts'

export interface ReconcileResult {
  /** Changed in the work tree, never authorized: the run freezes. */
  unauthorized: string[]
  /** Authorized but no longer changed: the ledger no longer describes reality. */
  missing: string[]
}

/** Compare the ledger's authorized files with git's actual changed files. */
export function reconcile(authorized: readonly string[], changed: readonly string[]): ReconcileResult {
  const allowed = new Set(authorized.map(normalizePath).filter(Boolean))
  const actual = new Set(changed.map(normalizePath).filter(Boolean))
  return {
    unauthorized: [...actual].filter(file => !allowed.has(file)).sort(),
    missing: [...allowed].filter(file => !actual.has(file)).sort(),
  }
}
