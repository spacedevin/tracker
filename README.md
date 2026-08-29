# Tracker

Syncs the public portfolio catalog into:

**https://github.com/users/spacedevin/projects/3**

Every row has:

| Field | Purpose |
|-------|---------|
| **Project** | Product name — use **Group by → Project** |
| **Latest updates** | Release tag/notes, or crates/npm/push summary |
| **Last updated** | Newest of release / push / npm / crates timestamps |
| **Synced** | When this row was last refreshed by Actions |
| **Latest release** / **Released** | Tip GitHub release |

## Views

1. Open https://github.com/users/spacedevin/projects/3  
2. Table view → add columns: Project, Latest updates, Last updated, Synced  
3. **Group by → Project**  
4. New view **Recent**: no group, sort by **Last updated** descending  

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
