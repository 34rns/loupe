# Installing Loupe

Loupe is a small program that runs inside your browser. You point at a photo or video, scroll, and it zooms in exactly where your pointer is.

It is **not** in any extension store yet. You install it by pointing the browser at a folder on your computer. That is what "load unpacked" means: the browser reads the extension straight from that folder instead of downloading it.

This build is for **Brave and other Chromium browsers** (Chrome, Edge, Opera, Vivaldi). It is version **0.1.0**.

---

## What you need

- Brave installed and open (the Chrome route is the same, see the bottom of this page).
- The project folder on your computer. Whatever you named it, the folder you pick later must be the one that contains `manifest.json` — here we will call it `loupe`.

- Inside that folder you should see `manifest.json`, plus the folders `popup`, `content`, `shared`, `icons`, `test`, `tools`, `docs`. `manifest.json` is the file the browser reads first. **The folder you give the browser must be the one that contains `manifest.json`.**

---

## Step 1 — Open the extensions page

Click the address bar at the top of the browser (the same bar you type `google.com` into), type this exactly, and press Enter:

```
brave://extensions
```

Do not search for it. Type it as an address.

You land on a page called **Extensions**. It lists everything currently installed, and it has a toggle labelled **Developer mode** in the top-right corner.

---

## Step 2 — Turn on Developer mode

Flip the **Developer mode** toggle on. This unlocks tools for loading extensions from disk. Nothing about it is dangerous; it only enables the buttons below. Leave it on: switching it off later makes the browser disable unpacked extensions such as this one until you switch it back on.

Three buttons appear in the top-left of the page: **Load unpacked**, **Pack extension**, **Update**.

> If you are on Chrome, the same page is at `chrome://extensions` and looks the same, because Chrome and Brave share the same extension engine. Edge uses `edge://extensions`.

---

## Step 3 — Load the folder

1. Click **Load unpacked**.
2. A folder picker opens. Navigate to wherever you put Loupe (Downloads, Documents, your own projects folder).
3. Single-click the **loupe** folder so it is highlighted. Do not open it and pick something inside it. If your copy lives somewhere else, select that `loupe` folder instead — the location does not matter, only that `manifest.json` is inside it.
4. Click **Select Folder** (the button reads **Select Folder** or **Open**, depending on the dialog).

**The rule that saves you trouble:** the folder you select must be the one holding `manifest.json`. If you select the parent folder instead of `loupe`, the browser shows an error like *"Manifest file is missing or unreadable"*. Go back and pick the inner folder.

---

## Step 4 — What you should see after it loads

A card appears on the Extensions page with:

- the name **Loupe**
- the version **0.1.0**
- the description: *"Hover any photo, video or artwork and scroll to zoom it right at your cursor. Hold left-click to pan."*
- a toggle switch (on), a circular reload arrow, a **Details** button and a **Remove** button
- an **Errors** button — on a healthy load this is grey and shows nothing. If it is red, click it and you will see the error text; that is the thing to report back.

**The steps and the resulting card are identical on Brave and Chrome**, because both use the same extensions page with different branding and a different address (`brave://` versus `chrome://`). Neither one adds a separate permission prompt: Loupe only asks for storage, which is how it remembers its own settings.

The browser may show a small notice about developer-mode extensions. It is informational. The extension stays loaded while Developer mode is on.

**The toolbar does not show Loupe yet.** That is the next step.

---

## Step 5 — Pin the icon to the toolbar

Near the address bar there is a puzzle-piece icon labelled **Extensions**. Click it. A small menu lists your extensions with a pin next to each; click the pin beside **Loupe** so the brass lens icon sits on the toolbar. If you cannot find the puzzle piece, open the browser menu (three dots, top-right), choose **Extensions**, and pin from there.

---

## Step 6 — Reload the tabs you already had open

Loupe attaches to pages when they load. Any tab that was open before you installed it will not know about Loupe until you refresh it (`Ctrl+R`). New tabs and newly opened sites work immediately.

---

## Step 7 — Check that it works

1. Open any page with a large photo — for example an Instagram post, a news article photo, a Reddit image.
2. Put the pointer **over the picture itself**.
3. Scroll **up** one notch on the mouse wheel.

The picture should zoom toward the pointer, and a small dark panel showing something like **1.4×** and **esc** should appear near your cursor (that panel is on by default and can be turned off in the settings panel). Scroll down and the picture returns to its normal size; once it is back at 1.0×, scrolling moves the page again rather than the picture. If nothing happens, jump to the troubleshooting section in [USE.md](USE.md#when-it-does-not-work).

---

## Chrome, Edge, Opera, Vivaldi

The steps are identical; only the address changes:

| Browser | Extensions page |
| --- | --- |
| Brave | `brave://extensions` |
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

On first load Chrome shows the same card with **Details**/**Remove** and the same grey **Errors** button. Chrome's page has a **Load unpacked** button in exactly the same place once Developer mode is on.

---

## Updating the folder later (including the logo swap)

Because the extension runs directly from the folder, any file change needs one extra step:

1. Replace whatever changed (for example, new files in `icons\` after your logo is turned into 16/32/48/128 pixel versions).
2. Open `brave://extensions`.
3. Find the Loupe card and click its **circular reload arrow**.
4. Refresh the pages you are testing.

You never need to remove and re-add the extension to update it. Do not move or rename the `loupe` folder while using it — the browser holds a link to that exact path. If you do move it, remove the broken card and load the folder again from the new place.

To hand the extension to someone else, zip the whole `loupe` folder and send it with this guide. On their machine they must **unzip it first** (a folder inside a zip cannot be loaded), then run the same steps and select the folder wherever they extracted it — their path will not be the same as yours, and that is fine.

---

## Uninstalling

On the Loupe card, click **Remove**, then confirm. The folder on disk is untouched; you can load it again any time.

---

## Optional: running the automated checks

This is only for someone comfortable with a terminal, and it is not needed to use the extension. It requires Node.js installed (the free download at nodejs.org).

```
cd path\to\loupe
npm install
npm run test:unit
npm run test:e2e
```

`test:unit` runs 19 checks of the zoom maths and the settings contract; `test:e2e` runs 41 browser tests that load the extension into a real Chromium and drive the gestures, the panel and the on-screen readout. The first `test:e2e` run downloads a separate copy of Chromium for testing (a few hundred megabytes) — it does not touch the browser you use day to day.
