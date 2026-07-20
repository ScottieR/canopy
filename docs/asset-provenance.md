# Asset provenance

This inventory covers non-code visual assets committed to the desktop repository. Runtime persona and habitat images are served by the Canopy control plane and are maintained in its separate catalog; they are intentionally not copied into this repository.

| Paths | Origin and purpose | Distribution |
|---|---|---|
| `app-icon-source.png` | Original Canopy icon source maintained by the project owner | Project artwork; included with the repository |
| `app-icon.png`, `public/app-icon.png`, `public/favicon.png`, `src-tauri/icons/**` | Derived application icons generated from the Canopy source icon | Project artwork; included in source and packaged builds |
| `assets/reference/Gemini_Generated_Image_*.png` | Google Gemini-generated concept studies created for Canopy | Development reference only; excluded from packaged builds |
| `assets/reference/lobster-onboarding-render.png` | AI-assisted Canopy onboarding concept study | Development reference only; excluded from packaged builds |
| `assets/reference/Accountant.png` | Canopy character concept used to evaluate procedural rendering | Development reference only; excluded from packaged builds |

No external font files are bundled. The UI uses system fallbacks for Manrope, Noto Serif, and JetBrains Mono declarations, avoiding an automatic font request during app startup.

Third-party source dependencies and container images retain their own licenses. Their code and binary contents are not relicensed by this repository's project license.

When adding an asset, record its author or generator, source date, applicable license or service terms, whether it is modified, and whether it ships in the application. Do not add scraped images, unlicensed model files, or production catalog exports.
