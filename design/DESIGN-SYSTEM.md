# BookLens — design system (short)

Single source of truth for visual decisions. Implementation lives in `style.css` (`:root` + sheet-scoped variables).

## Product posture

- **Mobile-first PWA**: max width ~500px shell, `100dvh`, safe-area insets.
- **Dark UI**: calm surfaces, one warm accent (orange), high legibility for long reading in the book sheet.
- **Utility over mood**: labels and actions are direct; emotional framing belongs in copy, not chrome.

## Color (CSS variables)

| Token | Role |
|--------|------|
| `--bg` `#0d0d0d` | Page background |
| `--surface` `#1a1a1a` | Header, panels |
| `--surf2` `#242424` | Gutter, secondary surfaces |
| `--surf3` `#2e2e2e` | Active / elevated |
| `--accent` `#f97316` | Primary actions, focus rings, highlights |
| `--text` `#f0f0f0` | Body |
| `--muted` `#8a8a8a` | Secondary text, affordances |
| `--border` `rgba(255,255,255,.07)` | Dividers |

**Sheet overlay** (inside `.book-sheet` scope): `--sheet-line`, `--sheet-glow` for borders and soft accent glow. Keep sheet chrome on this palette; do not introduce extra accent hues without updating this doc.

**Contrast**: body on surface should stay at or above **WCAG 2.2** normal text **4.5:1** (large text 3:1; UI components 3:1). Prefer `--text` on `--surface`, not pure white on pure black for long reading. [WCAG 2.2 REC](https://www.w3.org/TR/2024/REC-WCAG22-20241212/)

## Typography

| Layer | Stack | Use |
|--------|--------|-----|
| **App shell** | `system-ui` stack (see `body` in `style.css`) | Header, controls, settings |
| **Sheet UI** | `--sheet-ui`: `'Outfit', …` | Overlay lists, meta, buttons in sheet |
| **Sheet display** | `--sheet-display`: `'Fraunces', …` | Titles, author line, editorial feel |

**Google Fonts** are loaded in `index.html` (Outfit + Fraunces). New UI in the sheet should use the `--sheet-*` variables, not ad hoc families.

**Scale (guidance)**  
- Body / UI: **15px** in the shell today; **aim ≥16px** for new reading-heavy sheet blocks (aligns with common a11y heuristics and mobile readability research).  
- **Line-height**: ~1.45–1.6 for paragraphs; tighter for headings.  
- **Measure**: keep book description blocks readable (avoid full-bleed tiny text).

## Spacing & radius

- **Spacing**: prefer 4/8/12/16/24px rhythm; header uses `10px 16px` (legacy ok; new blocks align to 8px grid where possible).
- **Radius**: `--r` 14px (cards, sheets), `--r-sm` 9px, `--r-xs` 5px. Nested inner radius ≈ outer minus gap when stacking cards.

## Components (names to reuse)

- **Primary**: `.btn-primary` — one main action per view when possible.
- **Secondary**: `.btn-secondary-ghost` — non-destructive alternate.
- **Icon**: `.icon-btn` — header tools; min touch target ≥44px (see split gutter).
- **Modal**: `.modal` / `.modal-sheet` / `.sheet-handle` — settings pattern.
- **Split**: `.split-root`, `.split-gutter` — draggable divider; gutter is a touch affordance, not decoration.

## Motion

- Short transitions (opacity, transform). Respect **`prefers-reduced-motion`** for non-essential animation.
- Do not animate layout properties (width/height/top) for primary flows; use opacity/transform.

## Accessibility

- Visible **focus** (`:focus-visible`) on keyboard paths; accent outline on gutter already defined.
- **Labels** visible for inputs; no placeholder-only labels in forms.
- **Touch**: **[WCAG 2.2 AA SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)** sets a **24×24 CSS px** minimum (with spacing exceptions). For primary taps (camera, save, gutter), **default to 44×44 CSS px** per **[SC 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)** (AAA) as a product choice, not only AA compliance.
- **`aria-`** on dialogs and live regions when adding new overlays.

## Research alignment (May 2026)

External notes baked into `how-we-feel-uix-ux-reference.md` §7 and §4.7: **dark-mode legibility** (avoid ultra-muted grays on dark surfaces; see [NN/g on dark mode](https://www.nngroup.com/articles/dark-mode-users-issues/)), **contextual permissions** for camera/gallery ([BAM Tech camera checklist](https://www.bam.tech/en/article/the-essential-checklist-for-integrating-camera-functions-in-mobile-apps)), and **progressive disclosure** for dense emotion vocab. BookLens keeps a calm scanner shell; those patterns apply most when you extend journaling or capture flows.

## Content & tone (UI strings)

- French copy for user-facing text unless you intentionally ship an EN build.
- Prefer **specific verbs** (“Enregistrer”, “Autre photo”) over generic (“OK”, “Continuer”) when the next step matters.

## Anti-patterns (BookLens)

- Purple/indigo marketing gradients, decorative blob backgrounds.
- **Third font** beyond shell + Outfit + Fraunces for the same surface.
- Tiny legal-grey body text on `--surf2` (fails contrast and reading).
- New modals without backdrop focus trap and escape (match existing modal behavior).

## Related doc

For **emotion / check-in / journaling** patterns (not the BookLens chrome), see `design/how-we-feel-uix-ux-reference.md`. Use it when designing companion flows or marketing pages, not as a reason to add emotional UI noise to the scanner shell.

---

*Version: short — extend this file when you add a second theme, i18n, or a formal token build step.*
