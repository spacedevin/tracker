# Tracker

Syncs the public portfolio catalog into GitHub Project:

**https://github.com/users/spacedevin/projects/3**

- **Source:** [`config/catalog.yml`](config/catalog.yml)
- **Action:** hourly + on catalog changes
- **Auth:** `PROJECT_TOKEN` (classic PAT: `project` + `public_repo`) writes the Project; `GITHUB_TOKEN` reads public repos
- **Scope:** public sites, public GitHub, public npm/crates only

## Secrets / variables

| Name | Where | Value |
|------|--------|--------|
| `PROJECT_TOKEN` | Actions secret | classic PAT with `project` + `public_repo` |
| `PROJECT_OWNER` | Actions variable | `spacedevin` |
| `PROJECT_NUMBER` | Actions variable | `3` |

## Local sync

```bash
export PROJECT_TOKEN=ghp_...
export PROJECT_OWNER=spacedevin
export PROJECT_NUMBER=3
npm install
npm run sync
```

## Add a product

Append an item in `config/catalog.yml`, push — the Project table updates on the next sync.
