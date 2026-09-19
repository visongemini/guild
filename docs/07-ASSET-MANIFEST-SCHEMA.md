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
