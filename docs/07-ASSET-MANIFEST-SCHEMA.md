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

### guild-app-icon-v2 (2026-10-13, Guild 3.1)

- Use: macOS application icon and the user-selectable Dock icon (Settings > General). The dark variant is the bundle icon (`apps/desktop/build/icon.icns`; `apps/desktop/build/icon.png` is its 1024 px master) and the default Dock icon. The light variant (`apps/desktop/build/icon-light.png`, 1024 px) is the alternate Dock icon. Both PNGs ship as packaged resources (`Contents/Resources/icon.png`, `Contents/Resources/icon-light.png`) because the Dock icon is set at run time from a PNG. The sources are `apps/desktop/build/icon-dark.svg` and `icon-light.svg` (not packaged). `packages/ui/src/assets/dock-icon-dark.png` and `dock-icon-light.png` are 128 px previews for the Settings picker.
- Provenance: AI-generated, without an image model. Vector artwork written directly as SVG by Claude (Anthropic) on 2026-10-13 under BDV's direction: a squared-off letter G with rounded corners, drawn as one stroke and closed by an amber bar. No generative image model, no raster source and no third-party artwork were used; the earlier AI-generated icon and its banana mascot are not reused.
- Creator/provider: Claude (Anthropic), working in Claude Code for BDV; drawn 2026-10-13.
- Rights: output owned by BDV under the provider's terms; no third-party marks, characters or text.
- Transformation: both variants share one geometry on a 1024 px canvas: a rounded-square tile of 824 px at (100, 100), corner radius 186 px; the G is a 76 px stroke with round joins along `M626,292 L388,292 Q292,292 292,388 L292,636 Q292,732 388,732 L636,732 Q732,732 732,636 L732,512 L560,512`, and a 134 x 76 px bar at (560, 474) in the accent `#B1612A` forms the crossbar. Dark: tile `#1C1A17`, stroke `#FAF8F4`. Light: tile `#F3EEE5` with a 2 px inner hairline `#E2DBCF`, stroke `#1C1A17`. The 1024 px PNGs are RGBA renders of the SVGs: the opaque pixels span exactly 100 to 924 px on both axes (transparent margin, no shadow) and sampled edge and fill pixels match the SVG coordinates and colours. `icon.icns` (dark) holds ten PNG renditions, 16, 32, 128, 256 and 512 px each at 1x and 2x (`iconutil --convert iconset` on a copy lists them), and its 1024 px rendition is pixel-identical to `icon.png`. The two 128 px previews were made from the 1024 px PNGs with `sips -z 128 128`; repeating that reproduces both files byte for byte.
- Hashes (sha256): icon-dark.svg `d1aa7d97db89094f5086ee9fc15b666be92ae0f288b84a5123f2765efa838264`; icon-light.svg `1906cb8a4ac4ed9f2a95288b331a7b3738a147205671d306b71b38d73c142a4e`; icon.png `199c2747682655a96ad7e9c4433117301ea20140671f7d806fb0c95262b43a26`; icon-light.png `f7f350fd116024d5d4376eb88a8affaa82847d9956ea6f59dc59e9e70cd92fb2`; icon.icns `c96968e0721d874aaab776fac9e1ee477562f242d73eafe83f8fd6b5cce63f9c`; dock-icon-dark.png `3ebb5bb9dba881a59d224d8d9e3ac1601a9ac0975ce5f98e010829d20176d2cf`; dock-icon-light.png `02e3340ed5b322ec5c48f8b04b567cb34bf38b7f3ee87b4130c466b399db5bda`.
- Review: BDV reviewed the options on 2026-10-13 and chose the square G "I" (dark) as the default and "H" (light) as the alternate.

### guild-app-icon (2026-10-12, Guild 3.0.1; superseded by guild-app-icon-v2 on 2026-10-13)

- Status: replaced on 2026-10-13 by `guild-app-icon-v2`. The shipped files it describes (`icon.icns`, `icon.png`) were overwritten and survive only in git history; the record stays for provenance.
- Use: macOS application icon (`apps/desktop/build/icon.icns`; `apps/desktop/build/icon.png` was the 1024 px master).
- Provenance: AI-generated. OpenAI image generation through the Codex CLI on BDV's own subscription, prompted from the previous Guild icon (a light-trail letter G on black) with the banana mascot removed and the light recoloured to the Guild accent (warm amber to burnt orange).
- Creator/provider: BDV via OpenAI Codex CLI; generated 2026-10-12.
- Rights: output owned by BDV under the provider's terms; no third-party marks, characters or text.
- Transformation: crop to the tile, rescale to 824 px, rounded-square mask (radius 185 px) centred on a transparent 1024 px canvas with a soft shadow; `.icns` built with `iconutil` from 16-1024 px renditions.
- Hashes (sha256): generated source `1406abedad1e861ce76d019fc96ca2fa810896f5cf94d38542ea73bfa9df5d6a`; icon.png `2ca0dc83fea8137d1fe0c9d5a335b5c6c907b4faff2395abe728c3b988857564`; icon.icns `8c6a2fa73570c4ac48a86ed88e9de942b2e079ba1298b3176f1539079c166fb3`.
- Review: BDV chose this variant from three candidates on 2026-10-12.
