# Branching

Two branches, always identical:

- **`Development`** — where every new commit lands.
- **`main`** — production mirror that Railway watches.

`Development` and `main` must point at the **same commit** at all times. Any
divergence is a bug.

## Workflow for any change

```bash
# 1. Make sure you're on Development
git checkout Development

# 2. Commit your work
git add <files>
git commit -m "type(scope): subject"

# 3. Push Development to GitHub (visibility, CI)
git push origin Development

# 4. Fast-forward main to match Development
git checkout main
git merge Development --ff-only
git push origin main      # triggers Railway rebuild

# 5. Return to Development
git checkout Development
```

The `--ff-only` flag is the safety net: it refuses to merge if `main` has
diverged from `Development`. If that ever fails, stop — investigate before
forcing anything.

## Why not work directly on `main`?

Railway auto-deploys every push to `main`. Working there is the same as
deploying every keystroke. `Development` gives you a place to commit, run
tests, and review the diff before promoting.

## Hotfixes / risky experiments

Branch from `Development`, not `main`:

```bash
git checkout Development
git checkout -b fix/some-thing
# ...work...
git checkout Development
git merge fix/some-thing
# then run the 5-step sequence above to promote to main
```

## What never to do

- ❌ `git push --force` on `main` or `Development` (overwrites history)
- ❌ `git merge` without `--ff-only` (creates merge commits and divergence)
- ❌ Commit directly to `main` (skips Development)
- ❌ Let `main` get ahead of `Development` (breaks the invariant)
