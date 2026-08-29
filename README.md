# Tracker

Syncs the public portfolio catalog into:

**https://github.com/users/spacedevin/projects/3**

Every row has a **Project** field (chuggie, tish, dune, hypery, …). In the Project table view: **Group by → Project**.

- **Source:** [`config/catalog.yml`](config/catalog.yml) — each item must set `project:`
- **Action:** hourly + on catalog changes
- **Auth:** `PROJECT_TOKEN` writes the board; `GITHUB_TOKEN` reads public repos

## Secrets / variables

| Name | Where | Value |
|------|--------|--------|
| `PROJECT_TOKEN` | Actions secret | classic PAT: `project` + `public_repo` |
| `PROJECT_OWNER` | Actions variable | `spacedevin` |
| `PROJECT_NUMBER` | Actions variable | `3` |

## Group by Project

1. Open https://github.com/users/spacedevin/projects/3  
2. Table view → **Group by** → **Project**  
3. Optional: second view sorted by **Released** for recent releases  

## Add a product

```yaml
- id: my-thing
  title: my-thing
  url: https://example.com
  github: null
  npm: false
  cargo: false
  description: ...
  status: shipped
  family: other
  project: my-thing   # required — grouping key
  kind: company
```
