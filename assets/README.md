# Listing images

`card.png` (first `media` entry, the card thumbnail), `github-proxy-*.png` (screenshots) and `icon.png` are generated:

```bash
node .github/scripts/render-assets.mjs   # needs Chrome; CHROME=/path/to/chrome to override
```

- `icon.png` (512x512) comes from `favicon.svg`; `card.png` (1600x1000) from `card.svg`.
- The four screenshots (2000x1280) come from `listing/*.html`: illustrative mockups of the Overview, Auth, Policy and Activity tabs in the Paseo dark theme, with demo data only (`acme/web`, `acme/api`). They are not captures of a real install. Edit the HTML and re-render when a tab changes noticeably.
