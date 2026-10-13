# Bitbucket setup

## 1. Run Lookout in Pipelines

Use the Playwright image that matches the CLI's Playwright version, so screenshots always come from the same browser build.

```yaml
# bitbucket-pipelines.yml
image: mcr.microsoft.com/playwright:v1.56.1-noble

definitions:
  steps:
    - step: &visual-tests
        name: Visual tests (Lookout)
        caches: [node]
        script:
          - npm ci
          - npm run build-storybook --workspaces --if-present   # every Storybook in the monorepo
          - npx lookout run       # until @lookout/cli is published: node <path-to-lookout>/packages/cli/src/main.ts run
        # LOOKOUT_SERVER and LOOKOUT_TOKEN are repository variables

pipelines:
  pull-requests:
    '**':
      - step: *visual-tests      # BITBUCKET_PR_ID is only set in pull-request pipelines
  branches:
    main:
      - step: *visual-tests      # becomes the new baseline
```

The CLI reads `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`, `BITBUCKET_PR_ID` and `BITBUCKET_PR_DESTINATION_BRANCH` automatically. Add `--exit-code` if you also want the pipeline itself to go red while changes are unreviewed (usually not needed: the statuses already do that).

## 2. Let the server post statuses

Give the server an access token that can write commit statuses:

- **Cloud:** a repository or workspace access token with *Repositories: Write* scope (needed to post build statuses), set as `BITBUCKET_TOKEN`. An app password (`BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`) also works.
- **Data Center:** an HTTP access token with project or repository write permission, as `BITBUCKET_TOKEN`, and `kind: datacenter` + `baseUrl` in `.lookout.yml`.

Set `LOOKOUT_PUBLIC_URL` so the status links open the review page.

Optional webhook: point a repository webhook for *Pull request: Merged* at `https://<lookout>/api/webhooks/bitbucket` so accepted screenshots become `main`'s baseline immediately.

## 3. Choose how strict the merge check is

Lookout posts two statuses on the PR's latest commit:

| Status | Pending | Fails | Passes |
| --- | --- | --- | --- |
| Lookout: visual tests | Changes waiting to be accepted | A change was denied, or a story failed to capture | No changes, or all accepted |
| Lookout: UI review | Waiting for required reviewers | A reviewer requested changes | Required reviewers approved |

Bitbucket blocks a merge on them through the branch restriction on `main`: **"Minimum number of successful builds for the last commit with no failed builds and no in-progress builds"**, set to at least the number of required statuses (CI's own build counts too).

There are three sensible ways to use this; you can move between them by changing `bitbucket.statuses` and the branch restriction, with no code change.

| Option | `statuses` | Merge blocked until | Good for |
| --- | --- | --- | --- |
| **A. Lookout is the UI gate** (recommended end state) | `[visual, review]` | Every change accepted and the Lookout default reviewers approved | Design-system changes that must be signed off by design |
| **B. Bitbucket owns approvals** | `[visual]` | Every change accepted in Lookout; approvals come from Bitbucket's own default reviewers and "minimum approvals" check | Teams that want one place to approve |
| **C. Advisory** | `[visual, review]`, not required in the branch restriction | Nothing; statuses are shown but don't block | A trial period while you tune flaky stories |

Suggested path: start with **C** for a couple of weeks to shake out flaky stories, then switch to **A**.

**Plan caveat (Cloud):** merge checks only *block* on the Bitbucket Cloud Premium plan with "Prevent a merge with unresolved merge checks" enabled. On Standard they show as warnings. Data Center enforces them on every plan.
