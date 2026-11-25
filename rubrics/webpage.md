---
require_signoff: false
---
# Webpage

## Purpose

Check a change to a website, or a set of rendered pages, before it goes live: the visitor understands who this is for and what to do next, everything stated is true and current, and the page works on desktop and mobile. Review the code change and the rendered pages together when both are given.

## What to check

- Message: in the first screen, a visitor can tell who the site is for, what is offered and what to do next.
- Claims: numbers, dates, job titles, client names, results and testimonials are accurate, consistent across pages and language versions, and not overstated. A claim the author cannot back up is a finding.
- Calls to action: each page has a clear next step, and every button and link goes where it says.
- Links: no broken internal links, placeholder links (`#`, `TODO`) or links to staging and localhost.
- Language versions: when the site has several languages, the versions say the same thing (numbers, dates, names), and each page has the right `lang`.
- Search and sharing: each page has a specific title and meta description, a canonical URL where needed, and social preview tags (Open Graph) with a title, description and image.
- Accessibility: images have meaningful alt text (empty alt only for decoration), headings are in order (one h1), text contrast is readable, buttons and links have clear names, forms have labels.
- Layout: nothing overlaps, overflows or is cut off at desktop or mobile width; text is readable on mobile without zooming; tap targets are not too small.
- Privacy and legal (EU): analytics or tracking cookies need consent before they load; contact forms say how the data is used; the site has an imprint and privacy notice where required.
- Performance basics: no very large images or videos for small display sizes, no console errors.
- In the code change: secrets, API keys or private data committed to the repo, and content that is visible in the source but should not be public (drafts, internal notes).

## Out of scope

- Personal taste in design, colors and fonts, unless it hurts readability or accessibility.
- Framework and code style, unless it causes a visible bug.

## Impact anchors

- critical: a secret or private data exposed, wrong contact details, a false claim about a client or result that could cause legal or reputational harm.
- high: a wrong fact the visitor acts on (price, date, offer), a broken primary call to action, language versions that contradict each other, tracking without consent, a page broken at mobile width.
- medium: a missing or generic meta description or social preview, missing alt text on informative images, a broken secondary link, a confusing first screen.
- low: style and wording.
