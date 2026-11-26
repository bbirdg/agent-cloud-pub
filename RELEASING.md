# Releasing

1. Update `version` in `package.json` and add the changes to `CHANGELOG.md`.
2. `npm install --package-lock-only`, then commit: `Release 0.2.0`.
3. Tag and push: `git tag v0.2.0 && git push && git push --tags`.
4. The Release workflow runs every check, then stages the version on npm with provenance.
5. Approve it with your security key: `npm stage list @bbirdg/agent-cloud`, then `npm stage approve <id>`
   (or on the package's page on npmjs.com). Until then nothing is public.
