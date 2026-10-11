# Jivni website (jivnidesk.com)

A static site with no build step: five pages and an `assets/` folder. It is
self-contained so this folder can be moved to its own repository or deployed
as it is (Cloudflare Pages: no build command, output directory `website`).

| File | What it is |
| --- | --- |
| `index.html` | Landing page: the background video and tagline, the animated sample of the app, photographs, testimonials |
| `features.html` | One photo-led row per feature, then the clinic-size picker |
| `download.html` | Reads the latest GitHub release and offers the right file for the visitor's computer |
| `pricing.html` | Free and Enterprise plans for the hosted app at jivnidesk.app |
| `credits.html` | Every attribution on one page, built from `assets/config.js` |
| `assets/config.js` | Release repository, app address, and every video and photograph with its attribution |
| `assets/demo.js`, `assets/demo.css` | The scripted pointer and the large floating app sample |
| `assets/scenes.js`, `assets/scenes.css` | The four smaller animated samples: patients, calendar, WhatsApp, bills |

## Preview

```sh
node website/serve.js
```

Then open http://localhost:4180. Edits show on refresh.

## Adding the real videos and photographs

Edit `assets/config.js` only. Give an entry its `src`, `author`, `source` and
`license`; the placeholder disappears and the credits page lists it. Keep
background videos short, muted, 1080p at most and a few megabytes; add a
`.webm` beside the `.mp4` and a `poster` image.

## Background video

`assets/media/backdrop.mp4` and `.webm` are three seconds from each of six
Pexels clips, crossfaded, at 1280 x 720 with no sound (about 1.6 MB and
1.1 MB). The clips and their authors are listed under `clips` in
`assets/config.js`, which is what the credits page shows. Visitors who ask
for reduced motion or data saving get the poster image instead.

## Photographs

The photographs in `assets/media/` were generated on the owner's local
ComfyUI with Z-Image Turbo (1536 x 1024) and are credited as generated
images. Replace one by changing its entry in `assets/config.js`.

## Testimonials

`testimonials` in `assets/config.js`. Entries with `sample: true` are
stand-ins and are labelled on the page; never publish an invented quote as a
real one.

## Downloads

`download.html` asks GitHub for the latest release of `releasesRepo` and
matches the file names that `packaging/build.py` produces. Until a release is
public the page says the first release is being prepared. Release files can
only be downloaded by the public from a public repository.

The logo files in `assets/` are copies of `packaging/icons/`; change the mark
in `packaging/make_icons.py`, not here.
