/**
 * Skill-declared tool bundle types.
 *
 * A skill is a bundle: its prose plus the tool dependencies it declares in its own
 * manifest. Only treatment receives those declared server seeds. Both arms share the same
 * callable MCP client and may connect to servers they discover independently. These declarations are host-side inputs, so this module deliberately lives
 * OUTSIDE the image-locked in-guest source closure listed in
 * `scripts/build-guest-runtime.mjs` and imports nothing.
 */

/** Path, inside the frozen skill snapshot, of the skill's own agent tool manifest. */
export const SKILL_TOOL_MANIFEST_PATH = "agents/openai.yaml";
export const MAX_SKILL_TOOL_MANIFEST_BYTES = 65_536;
export const MAX_SKILL_TOOL_SERVERS = 4;

export interface SkillToolServer {
  /** Declaration key, e.g. "arbitrumDocs". */
  readonly name: string;
  /** Only "streamable_http" is supported. */
  readonly transport: "streamable_http";
  readonly url: string;
  readonly description: string | null;
}

/**
 * The tool dependencies a skill declares in its own bundle are part of skill presence: only treatment receives these preparation seeds.
 */
export interface SkillToolBundle {
  readonly schemaVersion: 1;
  /** Snapshot-relative manifest path the declaration came from, or null when none exists. */
  readonly source: string | null;
  /** sha256 of the exact manifest bytes, or null when no manifest exists. */
  readonly sourceSha256: string | null;
  readonly servers: readonly SkillToolServer[];
}

export const EMPTY_SKILL_TOOL_BUNDLE: SkillToolBundle = { schemaVersion: 1, source: null, sourceSha256: null, servers: [] };
