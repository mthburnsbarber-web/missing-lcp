# missing-lcp

Find pages where Chrome records no Largest Contentful Paint, and see which first-screen elements it skipped and why.

```
$ npx missing-lcp file://$PWD/test/fixtures/offscreen-intro.html --no-throttle

file:///…/test/fixtures/offscreen-intro.html
  NO LCP. First contentful paint at 0.07 s, but nothing on the first screen qualified.
  - image img  339076 px² visible
      fills the whole viewport, so Chrome treats it as a background
  - text a.cta "Start free"  5953 px² visible
      was outside the viewport when first painted (an entrance animation from off-screen?)
  - text h1.sr "The headline lives in the picture"  1 px² visible
      clipped or squeezed to a pixel (visually hidden text never counts)
  Fix:
    · give the first screen one element Chrome counts: a visible headline or button, or keep the image a little smaller than the viewport
    · start the entrance on screen: animate scale or tilt instead of sliding in from outside the viewport
    · a visually hidden headline never counts; show one real headline
```

## Why

Lighthouse calls this `NO_LCP`: "The page did not display content that qualifies as a Largest Contentful Paint."
PageSpeed Insights then has no LCP to score, and field data has nothing to report. The page itself can look perfect.
Chrome only counts content it treats as foreground, and a modern landing page can avoid every kind:

- **A hero that fills the screen.** An image or background that covers the whole viewport is treated as a
  background, not content. Full-bleed heroes with oversize "cover" images are exactly that.
- **An entrance from off-screen.** A button or headline that is outside the viewport when it is first painted is not
  counted when it slides in later.
- **A fade-in from zero.** Content first painted at opacity 0 can be skipped too. Chrome's handling of this has
  changed over time, so the tool reports it as a likely cause, not a certainty.
- **A visually hidden headline.** Text clipped to a pixel for screen readers never counts.
- **A placeholder image.** Images with under 0.05 bits per displayed pixel are treated as empty placeholders.

We found this on our own sites. Twelve landing pages each opened on a full-screen painted frame, with the headline
inside the picture and the only real text on a dock button that slid up from below the screen. All twelve reported no
LCP. Making the dock deal in where it sits (scale and tilt instead of sliding from off-screen) gave each page an LCP of
0.7 to 1.4 seconds on Lighthouse's mobile profile, without changing how the pages look.

## Usage

Needs Node 18 or newer and Playwright's Chromium (`npx playwright install chromium`).

```bash
npx missing-lcp https://example.com/ https://example.com/pricing
```

| Option | What it does |
| --- | --- |
| `--desktop` | 1350 × 940 desktop viewport instead of a 412 × 823 phone |
| `--no-throttle` | skip Lighthouse's mobile throttling (4× CPU, 150 ms round trip, 1.6 Mbps down) |
| `--json` | one JSON object per URL: `lcp`, every LCP `candidate`, and the `firstScreen` elements with reason codes |
| `--wait <ms>` | how long to keep watching after the load event (default 3000) |

The exit code is 1 when any URL records no LCP, so it can gate a deploy:

```bash
npx missing-lcp https://staging.example.com/ || exit 1
```

Reason codes in `--json`: `fills-viewport`, `offscreen-at-first-paint`, `transparent-at-first-paint`, `clipped`,
`hidden`, `low-entropy`.

## How it works

Before any of the page's scripts run, it registers a `largest-contentful-paint` observer and a `paint` observer. On the
first frame after first contentful paint it records every image, background image and text element on the first
screen: how much of it is visible, its effective opacity (including ancestors), whether it is clipped, and whether it is
inside the viewport. After the load event it records them again. An element Chrome skipped is judged by what it looked
like on that first frame.

## Limits

- One cold lab load in Chromium. Field LCP from real visitors (CrUX) can differ.
- The first-frame snapshot is taken once, right after first contentful paint. An element that first appears later is
  judged by its state after load.
- It explains one failure, a missing or tiny LCP. It does not replace Lighthouse or PageSpeed Insights.

## Tests

```bash
npm test
```

Three fixture pages served on 127.0.0.1: a full-bleed hero only (no LCP), the same with a button that slides in from
below (no LCP), and the same with the button dealt in where it sits (LCP recorded).

## License

MIT. Made by [Black Label Tec](https://blacklabeltec.com).
