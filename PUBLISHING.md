# Publishing to GitHub

This directory is the complete source tree for a DeepSeek Harness plugin bundle. It has no build step and no runtime npm dependencies.

## 1. Before pushing

1. Confirm the version in `package.json` (currently `1.0.0`).
2. Optionally add repository metadata after creating the GitHub repo:

   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/<your-account>/dsh-web-read.git"
   },
   "homepage": "https://github.com/<your-account>/dsh-web-read#readme",
   "bugs": {
     "url": "https://github.com/<your-account>/dsh-web-read/issues"
   }
   ```

3. Run the unit tests locally:

   ```bash
   npm test
   ```

   `npm test` runs only the offline unit tests. The live browser test (`npm run test:live -- <url> <mode>`) needs a desktop session, a network and a non-restricted process; it is not part of CI.

4. Do **not** commit:

   - `node_modules/`
   - `runtime-debug.log` or other logs
   - a DSH profile's `cordis.patch.yml` / `.dsh-market/state.json`
   - `release/` or generated archives

   The included `.gitignore` covers these.

## 2. Push the repository

```bash
git init
git add .
git commit -m "Initial release: dsh-web-read 1.0.0"
git branch -M main

# create an empty repository named dsh-web-read on GitHub first, then:
git remote add origin https://github.com/<your-account>/dsh-web-read.git
git push -u origin main
```

If you use the GitHub CLI:

```bash
gh repo create dsh-web-read --public --source=. --remote=origin --push
```

## 3. Create the release

```bash
git tag -a v1.0.0 -m "dsh-web-read 1.0.0"
git push origin v1.0.0
```

Create a GitHub Release for `v1.0.0`, paste the relevant section of `CHANGELOG.md`, and attach the generated archive:

- `dsh-web-read-1.0.0.zip`
- `dsh-web-read-1.0.0.tar.gz` (optional)
- `SHA256SUMS.txt`

The archive contains a top-level `dsh-web-read/` directory and excludes `.git`, `node_modules`, logs and local profile state.

## 4. Install from the repository

After cloning (or after a release archive is unpacked), install the directory as a DSH bundle:

```json
{
  "action": "install_bundle",
  "target": "C:\\path\\to\\dsh-web-read"
}
```

A git URL can also be used if the DSH plugin manager accepts git specs:

```text
https://github.com/<your-account>/dsh-web-read.git
```

Restart Harness if the Host process has already loaded an older copy. Then call:

```json
{
  "url": "https://example.com/",
  "mode": "text"
}
```

## 5. Optional: npm

The package has no `private` flag in this release. If you also want to publish to npm:

1. Check that `dsh-web-read` is still available on your registry.
2. Run `npm pack --dry-run` and review the file list.
3. Run `npm publish --access public`.

The package is primarily a DSH bundle; npm publication is optional.
