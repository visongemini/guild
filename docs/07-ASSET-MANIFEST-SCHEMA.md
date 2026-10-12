# Asset provenance manifest schema

Every bundled image, animation, sound, font, or other media record contains:

- stable asset identifier and product use;
- provenance category: `human-authored`, `AI-assisted`, `AI-generated`, or `third-party`;
- original source path outside the old repository and installed 1.1 bundle;
- creator/provider, creation date, and generation/purchase/license evidence;
- exact usage rights, redistribution limits, attribution, and exclusivity status;
- canonical source hash and every derived-output hash;
- transformation history;
- design-lineage/trademark review disposition;
- human BDV approval and review date.

An asset whose only source is the old repository or installed application is unverified and
does not transfer. “BDV-owned” is used only where the record supports ownership; otherwise the
manifest states the narrower verified usage right. Fonts and sounds follow the same rule.

## Records

### guild-app-icon (2026-10-12, Guild 3.0.1)

- Use: macOS application icon (`apps/desktop/build/icon.icns`; `apps/desktop/build/icon.png` is the 1024 px master).
- Provenance: AI-generated. OpenAI image generation through the Codex CLI on BDV's own subscription, prompted from the previous Guild icon (a light-trail letter G on black) with the banana mascot removed and the light recoloured to the Guild accent (warm amber to burnt orange).
- Creator/provider: BDV via OpenAI Codex CLI; generated 2026-10-12.
- Rights: output owned by BDV under the provider's terms; no third-party marks, characters or text.
- Transformation: crop to the tile, rescale to 824 px, rounded-square mask (radius 185 px) centred on a transparent 1024 px canvas with a soft shadow; `.icns` built with `iconutil` from 16-1024 px renditions.
- Hashes (sha256): generated source `1406abedad1e861ce76d019fc96ca2fa810896f5cf94d38542ea73bfa9df5d6a`; icon.png `2ca0dc83fea8137d1fe0c9d5a335b5c6c907b4faff2395abe728c3b988857564`; icon.icns `8c6a2fa73570c4ac48a86ed88e9de942b2e079ba1298b3176f1539079c166fb3`.
- Review: BDV chose this variant from three candidates on 2026-10-12.
