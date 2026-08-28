# Tracker

Public portfolio spreadsheet for [@spacedevin](https://github.com/spacedevin) companies and projects.

- **Source of truth:** [`config/catalog.yml`](config/catalog.yml) (edit titles, URLs, descriptions, status, family here)
- **Generated tables:** [`TRACKER.md`](TRACKER.md) · [shipped](docs/shipped.md) · [wip](docs/wip.md) · [by family](docs/by-family.md) · [recent releases](docs/recent-releases.md)
- **Sync:** GitHub Actions hourly + on catalog changes (`GITHUB_TOKEN` only — no PAT)
- **Scope:** public GitHub repos, public websites, public npm, public crates. Nothing private.

## Columns

| Column | Meaning |
|--------|---------|
| Github / NPM / Cargo | Presence checkmarks refreshed by sync |
| Live | Public URL returned 2xx (anonymous HTTPS) |
| Latest release / Released | Tip release from public GitHub (non-prerelease by default) |

## Local sync

```bash
npm install
npm run sync
```

Optional: `GITHUB_TOKEN` for higher GitHub API rate limits; public reads work without it.

## Add a product

1. Append an item under `items:` in `config/catalog.yml`
2. Use only **public** `github: owner/repo` (or `null` for site/crate-only)
3. Push — Actions regenerates the markdown tables
