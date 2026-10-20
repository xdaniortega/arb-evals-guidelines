/**
 * Declared egress policy vs. enforced egress rule.
 *
 * The declared `NetworkPolicy` is what gets hashed into the parity binding, so if the
 * guest entrypoint enforced a DIFFERENT port list, sealed evidence would assert something
 * the guest never did. Two files happening to agree is not a guarantee, so the enforced
 * list is DERIVED from the declared one: `configure-egress.sh` reads
 * `EVAL_ALLOWED_TCP_PORTS` and fails closed without it, and the sandbox supplies that
 * value from the policy the network was created with.
 *
 * These tests exist to keep that derivation intact. They run everywhere: no container
 * runtime is touched.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvalError } from "../core/types.ts";
import { EVAL_NETWORK_POLICY } from "../runner/run.ts";
import { ALLOWED_TCP_PORTS_VARIABLE, encodeAllowedTcpPorts } from "./apple-container.ts";

const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(evalsRoot, "container", "configure-egress.sh");

async function script(): Promise<string> {
  return await readFile(scriptPath, "utf8");
}

describe("declared network policy and enforced egress cannot diverge", () => {
  it("permits all public outbound TCP ports and keeps host-adjacent ranges denied", () => {
    // Deliberate repository owner instruction: outbound internet ports are unrestricted ("all"),
    // while host and private-range isolation remains fully enforced across all nine deny ranges.
    expect(EVAL_NETWORK_POLICY.allowPublicTcpPorts).toBe("all");
    expect(EVAL_NETWORK_POLICY.denyRanges).toEqual([
      "0.0.0.0/8",
      "10.0.0.0/8",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "::1/128",
      "fc00::/7",
      "fe80::/10",
    ]);
  });

  it("derives the enforced port list from the declared policy rather than hardcoding it", async () => {
    const text = await script();
    expect(text).toContain(`ALLOWED_TCP_PORTS="\${${ALLOWED_TCP_PORTS_VARIABLE}:-}"`);
    expect(text).toContain('iptables -A OUTPUT -p tcp -m multiport ! --dports "$ALLOWED_TCP_PORTS" -j REJECT');
    // No independent second source of truth may remain in the script.
    expect(text).not.toMatch(/--dports\s+[0-9]/);
  });

  it("fails closed when the declared allowlist is missing or malformed", async () => {
    const text = await script();
    expect(text).toContain(`fail "${ALLOWED_TCP_PORTS_VARIABLE} is required for the public profile`);
    expect(text).toContain("*[!0-9,]*)");
  });

  it("encodes the declared policy into exactly the string the script enforces", () => {
    expect(encodeAllowedTcpPorts(EVAL_NETWORK_POLICY.allowPublicTcpPorts, "test")).toBe("all");
    expect(encodeAllowedTcpPorts([443, 80], "test")).toBe("80,443");
  });

  it("refuses an allowlist that could not be enforced", () => {
    for (const ports of [[], [0], [70_000], [1.5]]) {
      let caught: unknown;
      try {
        encodeAllowedTcpPorts(ports, "test");
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvalError);
      expect((caught as EvalError).code).toBe("input-invalid");
    }
  });

  it("derives every public egress probe expectation from the same declared allowlist", async () => {
    const supervisor = await readFile(join(evalsRoot, "container", "run-measured.mjs"), "utf8");
    expect(supervisor).toContain(`process.env.${ALLOWED_TCP_PORTS_VARIABLE}`);
    // The expectation is computed from the declared list, allowing both "all" and specific port lists.
    expect(supervisor).toContain(
      'expectation: ports === "all" || (Array.isArray(ports) && ports.includes(port)) ? "connected" : "blocked"',
    );
    expect(supervisor).toContain("const PUBLIC_PROBE_PORTS = [443, 80];");
  });

  it("keeps the isolated validator profile at total denial", async () => {
    const text = await script();
    expect(text).toContain("iptables -P OUTPUT DROP");
  });
});
