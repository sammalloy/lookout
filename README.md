# Lookout

Self-hosted visual testing and UI review for Storybook, built as an alternative to Chromatic for our design system.

- **Visual tests.** Screenshots every story in every mode (viewport × theme), compares them with the approved baseline, and flags differences.
- **UI review.** One review page per pull request with side-by-side, diff and overlay views, accept/deny per snapshot, comments, and Approve / Request changes.
- **Default reviewers.** Rules in `.lookout.yml` decide who has to approve which changes, like CODEOWNERS.
- **Bitbucket gate.** Lookout posts build statuses on the PR's commit; a branch restriction that requires passing builds stops the merge until they are green.
- **Impact across apps.** Every project in the repo (the design system and each app with a Storybook) is captured for the same commit, and the review page shows a component × project table of what changed where.

## Quick start (local)

Requires Node 22.18 or newer (TypeScript runs directly, no build step).

```sh
npm install
npx playwright install chromium     # once per machine

npm run server                       # http://localhost:4400

# in another terminal: build a Storybook and capture it
cd examples/design-system
npm install
npm run build-storybook
node ../../packages/cli/src/main.ts run --branch main      # first run becomes the baseline
```

Then change something (for example `--ds-primary` in `examples/design-system/src/tokens.css`), rebuild, and capture as a PR:

```sh
npm run build-storybook
node ../../packages/cli/src/main.ts run --branch my-change --pr 1
```

Open the printed review link.

## Configuration: `.lookout.yml`

Put this at the root of the repo that runs the CLI. See [`.lookout.example.yml`](.lookout.example.yml) for every option.

```yaml
server: https://lookout.internal.example.com
baseBranch: main
projects:                      # one entry per Storybook build in the monorepo
  - name: design-system
    storybook: packages/ui/storybook-static
  - name: checkout
    storybook: apps/checkout/storybook-static
modes:
  viewports:
    - { name: desktop, width: 1280, height: 800 }
    - { name: mobile, width: 375, height: 812 }
  themes: [light, dark]        # passed to Storybook as ?globals=theme:dark
reviewers:
  default: ["@design-system-team"]
  groups:
    design-system-team: [alice, bob]
  rules:
    - match: "checkout/**"     # "<project>/<story title>/<story name>"
      reviewers: [carol]
approval:
  minimum: 1
  perRule: true                # every matched rule needs one of its reviewers
  dismissOnNewChanges: true    # a push that changes the screenshots resets approvals
bitbucket:
  kind: cloud                  # or datacenter (then also baseUrl)
  workspace: acme
  repo: frontend
  statuses: [visual, review]
```

### Per-story options

```js
export const Loading = {
  parameters: {
    lookout: {
      disable: false,             // skip this story
      delay: 300,                 // wait before capturing (ms)
      ignoreSelectors: ['.clock'],// masked before comparing
      modes: ['mobile-light'],    // only these modes
      diffThreshold: 0.2,         // per-pixel colour tolerance, 0..1
      capture: 'page',            // full page instead of cropping to the story
    },
  },
};
```

Lookout waits for Storybook to finish rendering (including `play` functions), web fonts, and network idle, disables CSS animations, and retakes a screenshot until two consecutive shots match.

## How baselines work

- Builds on `baseBranch` are accepted automatically and become the baseline (`autoAcceptOnBaseBranch: true`).
- A PR build compares each snapshot with the base branch's baseline.
- Accepting a snapshot in a PR stores it as that branch's baseline, so later pushes with the same screenshot stay accepted.
- After the merge, the next `main` build takes over the new screenshots. A Bitbucket webhook (`pullrequest:fulfilled` → `POST /api/webhooks/bitbucket`) can promote them straight away.

## Running in Bitbucket Pipelines

See [`docs/bitbucket.md`](docs/bitbucket.md) for the pipeline, the server settings, and the merge-check options.

## Monorepo today, separate repos later

Today every app lives in the same repo, so one pipeline builds each Storybook and runs `lookout run`; all projects land on the same commit and the review page shows them together. When apps move to their own repos, the plan is a preview package of the design-system PR that each app's pipeline installs and captures with `--pr` pointing back at the design-system PR. See the plan doc's "Downstream impact" section.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Config, reviewer rules, image diffing (pixelmatch) |
| `packages/cli` | `lookout run` / `lookout capture`: serves the Storybook build, captures with Playwright, uploads |
| `packages/server` | HTTP API, SQLite + on-disk image store, baselines, reviews, Bitbucket statuses |
| `packages/server/public` | Review web app (no build step) |
| `examples/design-system` | Small React Storybook to try it on |
| `test` | End-to-end test with a fake Storybook and a fake Bitbucket |

`npm test` runs the tests; `npm run typecheck` runs TypeScript.

## Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 4400 | HTTP port |
| `LOOKOUT_DATA_DIR` | `.lookout-data` | SQLite database and images |
| `LOOKOUT_PUBLIC_URL` | `http://localhost:$PORT` | Used in the links on Bitbucket statuses |
| `LOOKOUT_TOKEN` | unset | If set, the CLI must send it (`LOOKOUT_TOKEN` in CI) to upload |
| `BITBUCKET_TOKEN` | unset | Access token used to post build statuses (or `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`) |

## Not built yet

- Sign-in: reviewers type their Bitbucket username. Next step is Bitbucket OAuth so approvals are tied to real accounts.
- S3 / Postgres storage for running as a shared team service (the storage and database are behind small interfaces).
- Code Insights report in the PR sidebar, and auto-adding Lookout reviewers to the Bitbucket PR.
- Only re-capturing stories affected by the change (TurboSnap-style).
- Cross-repo impact via preview packages, for when apps leave the monorepo.
- Accessibility checks, Slack notifications, Firefox/WebKit.
