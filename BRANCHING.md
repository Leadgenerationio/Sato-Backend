# Branching and review

Two developers work on this repo: **Yash** and **Hari**. These rules apply to
every change, including small ones.

## The branches

- **`main` is production.** Never commit, merge, push or change settings on
  `main`, or on the production services. Going to production is a separate
  decision, taken after Sam signs off on staging, through one reviewed PR.
- **`staging` is where all work happens.** The staging Railway service and the
  staging Vercel preview always run the tip of `staging`.
- The old `Development` branch is no longer used.

## Rules

1. **Start from `staging`.** `git fetch origin && git checkout -b feat/short-name origin/staging`.
   Never branch from `main`.
2. **Every change has a PR, and its base is `staging`.** No direct pushes to
   `staging`, no force-pushes anywhere.
3. **The other developer approves.** Yash's PRs are approved by Hari. Hari's PRs
   are approved by Yash. The author never approves or merges their own PR before
   the other developer has approved it. (`.github/CODEOWNERS` asks the other
   person for a review automatically.)
4. **Merging an approved PR into `staging` deploys it.** Then check it on
   staging with a real call, and update the tracker.
5. **Say it in the PR.** The description names the tracker target(s) it
   finishes, what was tested, and what is not in it. Use the PR template.
6. **The tracker is the record.** Every PR and every deploy is on the plan and
   tracker page (the shared artifact). A target is done only when it is in
   `staging`, deployed, and checked there.
7. **Migrations.** Re-check the migration number against `origin/staging` before
   every push: two open PRs must not use the same number.

## Promote to `main` (later, not now)

Only after Sam signs off on staging, and only on Yash's say-so: one PR from
`staging` to `main`, approved by Hari, merged by Yash. Nothing else touches `main`.

## What never to do

- Commit or push to `main`.
- Branch from `main`, or open a PR whose base is `main`, for this work.
- Merge your own PR before the other developer approves it.
- `git push --force` on `staging` or `main`.
- Run a command that can change production settings (for example `vercel curl`,
  which creates a deployment-protection bypass secret, or any `--prod` deploy).
