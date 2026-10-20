import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256, sha256Hex } from "../core/experiment.ts";
import {
  EMPTY_SKILL_TOOL_BUNDLE,
  MAX_SKILL_TOOL_MANIFEST_BYTES,
  SKILL_TOOL_MANIFEST_PATH,
} from "../core/skill-tools.ts";
import { EvalError } from "../core/types.ts";
import { parseSkillToolBundle, resolveSkillToolBundle, validateSkillToolBundle } from "./skill-tool-manifest.ts";

describe("skill-tool-manifest", () => {
  const repoRoot = process.cwd();
  const realManifestRelPath = join("skills", "arbitrum-docs", SKILL_TOOL_MANIFEST_PATH);

  it("parses the real skills/arbitrum-docs/agents/openai.yaml to the exact expected bundle", async () => {
    const rawBytes = await readFile(join(repoRoot, realManifestRelPath));
    const rawText = rawBytes.toString("utf8");
    const sourceSha256 = sha256Hex(rawBytes);

    const bundle = parseSkillToolBundle(rawText, SKILL_TOOL_MANIFEST_PATH, sourceSha256, "real-manifest");
    expect(bundle).toEqual({
      schemaVersion: 1,
      source: "agents/openai.yaml",
      sourceSha256,
      servers: [
        {
          name: "arbitrumDocs",
          transport: "streamable_http",
          url: "https://mcp.inkeep.com/offchainlabs/mcp",
          description: "Official Arbitrum documentation search and question answering",
        },
      ],
    });
  });

  it("resolveSkillToolBundle reads from frozen snapshot directory", async () => {
    const snapshotDir = join(repoRoot, "skills", "arbitrum-docs");
    const bundle = await resolveSkillToolBundle({ snapshotDir, at: "test-snapshot" });
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.source).toBe(SKILL_TOOL_MANIFEST_PATH);
    expect(bundle.servers).toHaveLength(1);
    expect(bundle.servers[0]?.name).toBe("arbitrumDocs");
  });

  it("yields EMPTY_SKILL_TOOL_BUNDLE when manifest is absent in snapshot", async () => {
    const emptyDir = repoRoot; // repoRoot does not have agents/openai.yaml directly
    const bundle = await resolveSkillToolBundle({ snapshotDir: emptyDir, at: "absent-test" });
    expect(bundle).toEqual(EMPTY_SKILL_TOOL_BUNDLE);
  });

  it("ignores non-mcp dependencies.tools entry", () => {
    const yaml = `
dependencies:
  tools:
    - type: "custom_plugin"
      value: "ignoredTool"
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://mcp.inkeep.com/offchainlabs/mcp"
`;
    const bundle = parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test");
    expect(bundle.servers).toHaveLength(1);
    expect(bundle.servers[0]?.name).toBe("arbitrumDocs");
  });

  it("canonical hash of the parsed bundle is stable across two parses", async () => {
    const rawBytes = await readFile(join(repoRoot, realManifestRelPath));
    const rawText = rawBytes.toString("utf8");
    const hash = sha256Hex(rawBytes);

    const b1 = parseSkillToolBundle(rawText, SKILL_TOOL_MANIFEST_PATH, hash, "test-1");
    const b2 = parseSkillToolBundle(rawText, SKILL_TOOL_MANIFEST_PATH, hash, "test-2");

    expect(canonicalJsonSha256(b1)).toBe(canonicalJsonSha256(b2));
  });

  // Rejection cases
  const validBase = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://mcp.inkeep.com/offchainlabs/mcp"
`;

  function expectInputInvalid(fn: () => unknown, at = "test"): void {
    expect(fn).toThrowError(EvalError);
    try {
      fn();
    } catch (err: unknown) {
      expect((err as EvalError).code).toBe("input-invalid");
    }
  }

  it("rejects tab character", () => {
    expectInputInvalid(() =>
      parseSkillToolBundle(validBase.replace("  tools:", "\ttools:"), "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects flow collection starting value", () => {
    const yaml = `
dependencies:
  tools: { a: 1 }
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );

    const yaml2 = `
dependencies:
  tools:
    - [1, 2]
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml2, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects anchor, alias, or tag", () => {
    const yamlAnchor = `
dependencies:
  tools: &toolsAnchor
    - type: "mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yamlAnchor, "agents/openai.yaml", "00".repeat(32), "test"),
    );

    const yamlAlias = `
dependencies:
  tools: *toolsAnchor
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yamlAlias, "agents/openai.yaml", "00".repeat(32), "test"),
    );

    const yamlTag = `
dependencies:
  tools: !customTag
    - type: "mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yamlTag, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects block scalar", () => {
    const yaml = `
dependencies:
  tools: |
    - type: "mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects duplicate key in the same mapping", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "serverA"
      value: "serverB"
      transport: "streamable_http"
      url: "https://mcp.inkeep.com/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects depth > 5", () => {
    const yaml = `
l1:
  l2:
    l3:
      l4:
        l5:
          l6:
            l7: "too deep"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects oversized input", () => {
    const big = "a: " + "x".repeat(MAX_SKILL_TOOL_MANIFEST_BYTES + 10);
    expectInputInvalid(() =>
      parseSkillToolBundle(big, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects document separator", () => {
    const yaml = `
---
dependencies:
  tools: []
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects unknown key in an mcp entry", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://mcp.inkeep.com/offchainlabs/mcp"
      unknownKey: "rejected"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects transport: stdio", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "stdio"
      url: "https://mcp.inkeep.com/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects http:// url", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "http://mcp.inkeep.com/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects IP-literal host", () => {
    const yamlIpv4 = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://127.0.0.1/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yamlIpv4, "agents/openai.yaml", "00".repeat(32), "test"),
    );

    const yamlIpv6 = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://[::1]/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yamlIpv6, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects url with userinfo", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://user:pass@mcp.inkeep.com/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects non-443 port", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "arbitrumDocs"
      transport: "streamable_http"
      url: "https://mcp.inkeep.com:8443/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects duplicate value/name across mcp entries", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "dupName"
      transport: "streamable_http"
      url: "https://mcp1.inkeep.com/offchainlabs/mcp"
    - type: "mcp"
      value: "dupName"
      transport: "streamable_http"
      url: "https://mcp2.inkeep.com/offchainlabs/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  it("rejects more than 4 mcp servers", () => {
    const yaml = `
dependencies:
  tools:
    - type: "mcp"
      value: "server1"
      transport: "streamable_http"
      url: "https://mcp1.inkeep.com/mcp"
    - type: "mcp"
      value: "server2"
      transport: "streamable_http"
      url: "https://mcp2.inkeep.com/mcp"
    - type: "mcp"
      value: "server3"
      transport: "streamable_http"
      url: "https://mcp3.inkeep.com/mcp"
    - type: "mcp"
      value: "server4"
      transport: "streamable_http"
      url: "https://mcp4.inkeep.com/mcp"
    - type: "mcp"
      value: "server5"
      transport: "streamable_http"
      url: "https://mcp5.inkeep.com/mcp"
`;
    expectInputInvalid(() =>
      parseSkillToolBundle(yaml, "agents/openai.yaml", "00".repeat(32), "test"),
    );
  });

  describe("validateSkillToolBundle", () => {
    it("accepts a valid bundle and returns it", () => {
      const valid = {
        schemaVersion: 1,
        source: "agents/openai.yaml",
        sourceSha256: "00".repeat(32),
        servers: [
          {
            name: "arbitrumDocs",
            transport: "streamable_http" as const,
            url: "https://mcp.inkeep.com/offchainlabs/mcp",
            description: "Docs search",
          },
        ],
      };
      const result = validateSkillToolBundle(valid);
      expect(result).toEqual(valid);
    });

    it("accepts EMPTY_SKILL_TOOL_BUNDLE", () => {
      expect(validateSkillToolBundle(EMPTY_SKILL_TOOL_BUNDLE)).toEqual(EMPTY_SKILL_TOOL_BUNDLE);
    });

    it("rejects non-object or array", () => {
      expectInputInvalid(() => validateSkillToolBundle(null));
      expectInputInvalid(() => validateSkillToolBundle([]));
      expectInputInvalid(() => validateSkillToolBundle("string"));
    });

    it("rejects transport not equal to streamable_http", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "srv", transport: "stdio", url: "https://example.com", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects non-https URL", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "srv", transport: "streamable_http", url: "http://example.com", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects URL with userinfo", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "srv", transport: "streamable_http", url: "https://user:pass@example.com", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects URL with explicit non-443 port", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "srv", transport: "streamable_http", url: "https://example.com:8080", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects IP address host", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "srv", transport: "streamable_http", url: "https://127.0.0.1", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects more than 4 servers", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: Array.from({ length: 5 }, (_, i) => ({
          name: `srv${i}`,
          transport: "streamable_http",
          url: `https://example${i}.com`,
          description: null,
        })),
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects unsorted server names", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "serverB", transport: "streamable_http", url: "https://b.com", description: null },
          { name: "serverA", transport: "streamable_http", url: "https://a.com", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });

    it("rejects invalid server name syntax", () => {
      const bad = {
        schemaVersion: 1,
        source: null,
        sourceSha256: null,
        servers: [
          { name: "123invalid", transport: "streamable_http", url: "https://a.com", description: null },
        ],
      };
      expectInputInvalid(() => validateSkillToolBundle(bad));
    });
  });
});
