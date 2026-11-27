# Releasing myRP.build

How to cut a release and how the auto-updater actually reaches users. Written after
the **first** release ever cut (v0.1.1, 2026-07-30) — every gotcha below was hit for
real, not anticipated.

Releases run **locally, not in CI**, on purpose: signing needs the `TrustedSigning`
PowerShell module plus three Azure credentials from Infisical, and copying those into
Actions secrets on a **public** repo is a deliberate decision, not a launch-week reflex.

---

## The four links

A release is a chain. Each link can succeed while the next silently fails, which is
what makes this worth writing down.

| # | Link | Fails silently as |
|---|------|-------------------|
| 1 | **Sign** the binaries | An unsigned installer users' machines refuse or warn on |
| 2 | **Build** the installer | — (loudest link; fails obviously) |
| 3 | **Publish** installer **+ `latest.yml`** to GitHub | Installer downloads fine, updater is dead forever |
| 4 | **Update**: an installed copy sees the next version | Users stay on the version they first installed |

Link 3 is the dangerous one. `latest.yml` is the auto-updater's entire world — without
it, `electron-updater` has nothing to read, and the failure is invisible until the
second release, when nobody updates.

---

## Cutting a release

```bash
npm run release:check    # preflight only, no build — run this first, always
npm run release:win      # clean → build:prod → preflight → sign → publish draft
```

`release:win` = clean → production build → preflight → `electron-builder --win --publish always`.

**`--publish always` is load-bearing.** It is what uploads `latest.yml` *alongside* the
installer. Without it you get an installer and a dead updater.

### What preflight checks

`release:check` is read-only and refuses to waste a 4-minute build on a bad state:

- on `main`, clean tree, nothing unpushed, in sync with origin
- the version in `package.json` is not already released
- `TrustedSigning` module visible to `pwsh.exe`
- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` and a GitHub token —
  **checked by length only, never printed**
- `build/fastembed-models` and `build/lua-language-server` are bundled

---

## MANDATORY post-publish verification

**Do not skip this.** The first release ever cut produced **two** draft releases with the
assets split across them, and the build log reported complete success.

```bash
gh api repos/hamchowderr/myrp.build/releases \
  --jq '.[] | "id=\(.id) draft=\(.draft) tag=\(.tag_name) assets=[\(.assets | map(.name) | join(", "))]"'
```

You must see **exactly one** draft for the version, holding **all three** assets:

- `myRP.build-<version>-setup.exe`
- `latest.yml`
- `myRP.build-<version>-setup.exe.blockmap`

**If the assets are split across two drafts** (see `myrp-build-3ol`):
electron-builder ran two publish passes, and because a draft has no real git tag yet
(its URL is `/releases/tag/untagged-<hash>`), the second could not find the first and
made its own. Consolidate rather than rebuild — the artifacts are already signed:

```bash
# upload the missing asset to the draft that has latest.yml + the installer
gh api --method POST \
  "https://uploads.github.com/repos/hamchowderr/myrp.build/releases/<KEEP_ID>/assets?name=<FILE>" \
  --header "Content-Type: application/octet-stream" --input "dist/<FILE>"

# then delete the orphan — verify it holds nothing unique FIRST
gh api --method DELETE repos/hamchowderr/myrp.build/releases/<ORPHAN_ID>
```

---

## Order that matters

Releases publish as **drafts** (`releaseType: draft` in `electron-builder.yml`), invisible
until you publish them in the GitHub UI. Use that:

1. **Verify the assets** — the one-draft/three-assets check above.
2. **Install the artifact clean** and confirm it runs. A packaged build is a *different
   app*: `__DEV_BYPASS__` compiles to `false`, so it uses Discord OAuth, Stripe and cloud
   Supabase — none of which `npm run dev` exercises.
3. **Publish the draft**, then cut a `+1` version and confirm an installed copy
   **self-updates**.
4. Only then announce.

Step 3 is the one nobody tests until it fails, because it is the only step that cannot
be tested with a single release.

---

## How the updater actually works

`src/main/index.ts` wires `electron-updater`. On launch the app:

1. asks GitHub for the latest **published** release,
2. reads `latest.yml` from it (version, sha512, size),
3. compares against its own version,
4. downloads and applies if newer.

Consequences worth internalising:

- **A draft is invisible to the updater.** While `v0.1.1` sits as a draft, an installed
  copy logs `No published versions on GitHub`. That is correct behaviour, not a bug.
- **`latest.yml` must be on the same release as the installer.** The split-draft failure
  above breaks exactly this.
- **The blockmap enables differential downloads.** Missing it still works — it just falls
  back to downloading the whole installer.
- Updater activity is logged to `%APPDATA%\myrp-build\logs\main.log`. Check there first.

---

## Signing notes

- electron-builder resolves **`pwsh.exe` first**, falling back to `powershell.exe`. The two
  have separate module paths, so a module check against the wrong shell reports "missing"
  when signing works fine. electron-builder also self-installs the module when absent —
  treat that check as a warning, never a blocker.
- **Signing must run with the Azure env vars injected.** electron-builder uses
  `DefaultAzureCredential`; with no `AZURE_*` vars present it silently falls back to the
  **Azure CLI credential** — your own Owner login — which has permission. That masks a
  broken service principal and makes a local build "pass" while a clean machine fails.
  To test signing honestly, inject the credentials so `EnvironmentCredential` wins.
- The service principal needs the **`Artifact Signing Certificate Profile Signer`** role
  scoped to the signing account. Microsoft renamed Trusted Signing to Artifact Signing;
  the old role name no longer resolves. A 403 (not 401) means credentials authenticate
  fine but are not authorised.
- Certificates are **short-lived by design** and rotate; `NotAfter` a day or two out is
  normal. Signatures are timestamped, so they stay valid after the certificate expires.

Verify a signature for real:

```powershell
Get-AuthenticodeSignature "dist\myRP.build-<version>-setup.exe" |
  Select-Object Status, @{n='Signer';e={$_.SignerCertificate.Subject}}
```

`Status` must be `Valid`.

---

## Version bumping

`package.json` `version` drives the installer name, `latest.yml`, and the git tag.
Preflight refuses a version that is already released. Bump it in a normal commit on
`main` before running `release:win`.
