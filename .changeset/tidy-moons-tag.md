---

---

Fix the npm release path's git tags: configure the committer identity `changeset
publish` needs to write its annotated tags, tag with `changeset git-tag`, skip
the lefthook pre-push gate on the tag push, and verify the tags reached the
remote. Drop the nonexistent `NODE_AUTH_TOKEN` fallback, which left an empty
`_authToken` suppressing the OIDC exchange, and stop running the Version
Packages job on `workflow_dispatch`.

Empty on purpose: nothing shipped changed. `.github/workflows/ship.yml` is not
carried by any tarball or by the platform deploy, and the two files touched
under `packages/aai-templates/` are gate specs, which that private package
never publishes either. It is the same shape as the pending changeset from
\#1386, another change to the release path itself.
