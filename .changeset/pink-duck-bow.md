---
"aai-guest": patch
"@alexkroman1/aai": patch
---

Install a studio workspace's own package.json dependencies before building it.

A workspace's declared runtime dependencies only existed on disk as a side
effect of `add_dependency` having run in that exact directory, so they were
lost whenever the directory was rebuilt: `materializeWorkspace` opens with
`rm -rf` (session refresh, replica takeover), and Publish builds a fresh
directory from the store snapshot. Because the worker bundle is built with
`noExternal`, the absent package was not externalized but a hard build failure
naming a dependency the manifest plainly declares — so an agent could test fine
and then fail to publish, and a project pushed from a laptop could not build at
all. `npm install --omit=dev` now runs in the workspace whenever something it
declares is missing.

That is viable because the workspace manifest no longer declares the platform's
own packages. It used to pin them so they could be read, and npm reifies
whatever manifest it reads — so every install re-fetched the whole SDK tree.
Dropping them takes adding one package from 25s/156 MB to 451ms/28 KB, takes
`add_dependency` from 28s/202 MB to 3.8s/28 MB, and retires
`reconcileWorkspacePins`, whose only job was keeping those pins fresh. Both
readers the declaration served are covered elsewhere: the studio prompt lists
what is preinstalled, and `aai pull` fills the manifest in per entry from the
scaffold.

Also: `Cannot find module` (TS2307) now carries a hint pointing at
`add_dependency`, and the guest no longer syncs package-manager lockfiles into
the project — `npm install` leaves a ~100 KB `package-lock.json` that was the
bulk of every turn's sync payload and landed in pnpm projects via `aai pull`.
