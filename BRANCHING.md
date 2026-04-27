# Branching

Two branches, with a clear separation:

- **`main`** — **production**. Railway auto-deploys from this. Only stable,
  tested code lands here.
- **`Development`** — **testing / staging**. Every new commit goes here first.
  Verify it works, then promote to `main`.

`Development` may temporarily be **ahead** of `main` (changes in flight that
haven't been promoted yet). That's expected. `main` should **never** be ahead
of `Development`.

## Workflow for any change

```bash
# 1. Make sure you're on Development
git checkout Development

# 2. Commit your work
git add <files>
git commit -m "type(scope): subject"

# 3. Push Development to GitHub (visibility, optional staging deploy, manual test)
git push origin Development
```

**Stop here and verify.** Run tests, click through the app, check logs.
Only when you're confident the change is safe for production do you proceed:

```bash
# 4. Promote Development → main (production deploy)
git checkout main
git merge Development --ff-only
git push origin main      # triggers Railway prod rebuild

# 5. Return to Development
git checkout Development
```

The `--ff-only` flag is the safety net: it refuses to merge if `main` has
diverged from `Development`. If that ever fails, stop — investigate before
forcing anything.

## Why two branches?

- **`main`** is what Sam's clients hit. It must always work.
- **`Development`** is the safety buffer. You can land 5 commits, test them
  together, then promote them as one atomic step. If something goes wrong
  on `Development`, prod is unaffected.

## Hotfixes / risky experiments

Branch from `Development`, not `main`:

```bash
git checkout Development
git checkout -b fix/some-thing
# ...work...
git checkout Development
git merge fix/some-thing --ff-only
# then run the promote-to-main sequence above when ready
```

## What never to do

- ❌ Commit directly to `main` (skips testing on Development)
- ❌ Push to `main` without first having the same commits on `Development`
- ❌ `git push --force` on `main` or `Development` (overwrites history)
- ❌ `git merge` without `--ff-only` (creates merge commits and divergence)
- ❌ Let `main` get ahead of `Development` (breaks the invariant — `main` must
  be a subset of `Development`'s history)

## Quick state check

```bash
git log main..Development --oneline   # commits on Development not yet in main
git log Development..main --oneline   # SHOULD ALWAYS BE EMPTY
```

The second command should always return nothing. If it ever returns commits,
something is wrong and `main` has been pushed to without going through
`Development` first.
