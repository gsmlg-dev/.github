# Repository Guidelines

## Project Structure & Module Organization

This repository is the special `.github` repository for the `gsmlg-dev` organization. The main logic lives in [`scripts/update_readme.py`](/Users/gao/Workspace/gsmlg-dev/dot-github/scripts/update_readme.py), which fetches public repositories from GitHub and rewrites the generated section in [`profile/README.md`](/Users/gao/Workspace/gsmlg-dev/dot-github/profile/README.md). GitHub Actions workflows are stored in [`.github/workflows`](/Users/gao/Workspace/gsmlg-dev/dot-github/.github/workflows), and project metadata is defined in [`pyproject.toml`](/Users/gao/Workspace/gsmlg-dev/dot-github/pyproject.toml).

## Build, Test, and Development Commands

Install dependencies with `uv pip install .` from the repository root. Run the updater locally with `python scripts/update_readme.py`; set `GH_TOKEN` or `PERSONAL_ACCESS_TOKEN` first to avoid low GitHub API limits. There is no build step. Useful checks are lightweight: `python -m py_compile scripts/update_readme.py` validates syntax, and `git diff -- profile/README.md` lets you inspect the generated README changes before committing.

## Coding Style & Naming Conventions

Use Python with 4-space indentation and keep functions small and single-purpose, matching the existing script. Prefer descriptive `snake_case` names such as `fetch_repos` and `generate_readme_table`. Keep dependencies minimal; this project currently depends only on `requests`. When editing generated content, preserve the `<!--START_SECTION:repositories-->` and `<!--END_SECTION:repositories-->` markers exactly.

## Testing Guidelines

There is no formal test suite yet. For changes to the updater, run `python scripts/update_readme.py` against a valid token and verify that [`profile/README.md`](/Users/gao/Workspace/gsmlg-dev/dot-github/profile/README.md) updates correctly and remains valid Markdown. If you add tests, place them under a new `tests/` directory and name files `test_*.py`.

## Commit & Pull Request Guidelines

Follow the commit style already used in history: short, imperative messages with optional conventional prefixes, for example `docs(profile): auto-update readme with repo stats` or `chore: add uv.lock to gitignore`. Pull requests should describe the behavior change, note any workflow or token impact, and include a small diff summary for generated README changes. Link related issues when applicable.

## Security & Configuration Tips

Never hardcode tokens in code or docs. Use `GH_TOKEN`, `PERSONAL_ACCESS_TOKEN`, and GitHub Actions secrets. Changes to [`.github/workflows/update-readme.yml`](/Users/gao/Workspace/gsmlg-dev/dot-github/.github/workflows/update-readme.yml) should be reviewed carefully because they control write access and automated commits.
