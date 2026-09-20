/**
 * The one spelling of a repo-relative path. Git, the detection CSV and the
 * authorization ledger all have to agree, or a file the user authorized looks
 * like a file nobody authorized.
 *
 * It lives in `core/` because `detect` and `git` are mutually independent
 * sibling modules and both need it.
 */
export function normalizePath(path: string): string {
  const collapsed: string[] = []
  for (const part of path.trim().replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && collapsed.length > 0 && collapsed[collapsed.length - 1] !== '..') collapsed.pop()
    else collapsed.push(part)
  }
  return collapsed.join('/')
}
