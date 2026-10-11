# Jivni website (jivnidesk.com)

A static site with no build step: four pages and an `assets/` folder. It is
self-contained so this folder can be moved to its own repository or deployed
as it is (Cloudflare Pages: no build command, output directory `website`).

| File | What it is |
| --- | --- |
| `index.html` | Landing page with the animated sample of the app |
| `download.html` | Reads the latest GitHub release and offers the right file for the visitor's computer |
| `pricing.html` | Free and Enterprise plans for the hosted app at jivnidesk.app |
| `credits.html` | Every attribution on one page, built from `assets/config.js` |
| `assets/config.js` | Release repository, app address, and every video and photograph with its attribution |
| `assets/demo.js`, `assets/demo.css` | The scripted pointer and the floating app sample in the hero |

## Preview

```sh
npx serve website
```

## Adding the real videos and photographs

Edit `assets/config.js` only. Give an entry its `src`, `author`, `source` and
`license`; the placeholder disappears and the credits page lists it. Keep
background videos short, muted, 1080p at most and a few megabytes; add a
`.webm` beside the `.mp4` and a `poster` image.

## Downloads

`download.html` asks GitHub for the latest release of `releasesRepo` and
matches the file names that `packaging/build.py` produces. Until a release is
public the page says the first release is being prepared. Release files can
only be downloaded by the public from a public repository.

The logo files in `assets/` are copies of `packaging/icons/`; change the mark
in `packaging/make_icons.py`, not here.
