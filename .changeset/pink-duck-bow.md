---
"aai-guest": patch
---

Install a studio workspace's own package.json dependencies before building it.

A workspace's declared runtime dependencies only existed on disk as a side
effect of `add_dependency` having run in that exact directory, so they were
lost whenever the directory was rebuilt: `materializeWorkspace` opens with
`rm -rf` (session refresh, replica takeover), and Publish builds a fresh
directory from the store snapshot. Because the worker bundle is built with
`noExternal`, the absent package was not externalized but a hard build failure
naming a dependency the manifest plainly declares — so an agent could test
fine and then fail to publish, and a project pushed from a laptop could not
build at all.

Missing dependencies are now installed into the shared workspaces root, which
sits on every workspace's and build dir's resolution path. Only packages the
baked toolchain does not already provide are fetched (measured: 358ms/28 KB
against 25s/156 MB for reifying the workspace manifest), each in its own npm
run so one unreachable entry cannot fail the others, and a package that did
not install is removed from the shared manifest again. A failed install warns
rather than throwing, and the warning is prepended to a failing build or
publish.
