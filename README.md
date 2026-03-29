# GitHub Profile README Updater

This project automatically updates a GitHub profile README file with a dynamically generated list of public repositories from a GitHub organization. The update is performed by a Python script that is scheduled to run weekly via a GitHub Actions workflow.

## Cleanup Untagged Packages

A workflow and CLI tool to safely clean up untagged container image versions from GHCR, without breaking multi-arch tags.

### How it works

Multi-arch container tags (manifest lists) reference platform-specific child manifests that appear as "untagged" in the GitHub Packages API. Naively deleting all untagged versions breaks those tags. This tool:

1. Resolves child manifests of every tagged version via the ghcr.io registry API
2. Verifies child manifests actually exist (detects broken tags left by previous bad cleanups)
3. Only deletes versions that are truly orphaned (untagged and not referenced by any tag)
4. Skips the entire package if any manifest fetch fails (safe by default)

### GitHub Actions Workflow

Runs automatically every Saturday at 00:00 UTC via `.github/workflows/cleanup-untagged-packages.yml`. Only deletes orphaned versions older than 90 days.

### CLI Usage

```bash
# Dry-run all packages (default, safe — shows what would be deleted)
GH_TOKEN=$(gh auth token) node scripts/cleanup-untagged-packages.js

# Dry-run a single package
GH_TOKEN=$(gh auth token) node scripts/cleanup-untagged-packages.js --package alpine

# Ignore the 90-day age filter (delete broken/orphaned regardless of age)
GH_TOKEN=$(gh auth token) node scripts/cleanup-untagged-packages.js --package alpine --no-age-filter

# Actually delete (requires explicit opt-in)
GH_TOKEN=$(gh auth token) node scripts/cleanup-untagged-packages.js --package alpine --no-age-filter --delete
```

| Flag | Description |
|------|-------------|
| `--package <name>` | Only process this package (default: all) |
| `--no-age-filter` | Delete regardless of age (skip 90-day rule) |
| `--dry-run` | Show what would be deleted without deleting (default) |
| `--delete` | Actually delete (requires explicit opt-in) |

### Running Tests

```bash
npm test
```