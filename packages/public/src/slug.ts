/**
 * A DNS label made from a name: lowercase, each run of other characters a single dash, cut to
 * 30. A team's slug (`Acme Inc` → `acme-inc`), and the stack a git branch is forked into
 * (`feat/Login_v2` → `feat-login-v2`), named the same way wherever it is made.
 */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 30)
      // after the cut too: a cut on a dash would leave one at the end
      .replace(/-+$/, '') || 'team'
  );
}
