# Releasing Loupe

## To update, run `.\release.ps1 1.0.1`

```powershell
cd path\to\loupe
.\release.ps1 1.0.1
```

That one command:

1. writes `1.0.1` into `manifest.json`, the popup footer and the docs;
2. stages the files that actually ship and zips them as **`loupe.zip`**;
3. commits and pushes the version bump;
4. runs `gh release create v1.0.1 loupe.zip --latest`.

Pass any `major.minor.patch` version. The script refuses anything else.

## The download link never changes

The asset is **always** named `loupe.zip`, so this URL always resolves to the
newest build no matter how many releases you publish:

```
https://github.com/34rns/loupe/releases/latest/download/loupe.zip
```

Do not rename the asset per release, or that link breaks. `releases/latest`
always points at whatever release GitHub considers current.

## Prerequisites

- PowerShell 5.1 or newer (Windows 10/11 ships it).
- [GitHub CLI](https://cli.github.com/) installed and logged in — the script
  runs `gh auth status` first and stops if you are not authenticated.
- A git repository with a remote (`git remote -v` should show the GitHub URL).
  The release tag is created from the pushed commit, so the script pushes
  before it publishes.

## Unpacked extensions cannot auto-update

Loupe is installed with **Load unpacked**, which means it runs straight from a
folder on disk. There is no store, no update URL and no background update
check — the browser has no mechanism to refresh it.

So "updating" is a manual, three-step job for the person who installed it:

1. Download the new `loupe.zip` from the link above.
2. Replace the contents of the old folder.
3. Open the extensions page and click the **reload** arrow on the Loupe card.

Every tab opened before the reload still runs the old version until refreshed.

### Chrome Web Store later

**The Chrome Web Store is the option for automatic updates.** Publishing there
gives you a real `update_url`, so Chrome pulls new versions on its own, users
install with one click instead of Developer mode, and the extension stops
depending on the user never moving the folder.

To do it later: create a developer account, zip the same payload the script
already builds, upload it for review, and add a `update_url`-style manifest
entry only if you self-host — for the store, none is needed. Store listings
also want screenshots, so keep the captures in `.artifacts/` fresh.

Nothing about `release.ps1` changes when you do: the same script still bumps,
zips and tags, and you upload the zip it produced.
