#!/bin/sh
# Root PID 1 egress lock and privilege drop.
#
# WHY this script exists at all: Apple Container gives a guest a routable interface on a
# host-visible bridge, so BEFORE the lock the host's own LAN address and the network
# gateway are reachable from inside the guest. The contract requires host, gateway,
# loopback, private, link-local, metadata, and sibling ranges to be denied while locked
# public name resolution and public web transport stay available. Only a privileged
# process can install that policy, so exactly this much runs as root and nothing else.
#
# It handles NO credential of any kind. A credential reaches a guest only in memory over
# the supervisor's control socket, after attestation.
#
# It fails CLOSED: any rule that does not apply aborts the container instead of leaving a
# guest running with weaker egress than the evidence will claim.
#
# The permitted public TCP port list is DERIVED from the declared network policy via
# EVAL_ALLOWED_TCP_PORTS rather than written here, so the rule the guest enforces and the
# policy that is hashed into the parity binding cannot drift apart.
set -eu

EVAL_UID=10001
EVAL_GID=10001
EGRESS_PROFILE="${EVAL_EGRESS_PROFILE:-public}"
# The DECLARED network policy's allowPublicTcpPorts, passed in by the host that also
# hashes that policy into the parity binding. It is NOT hardcoded here: a literal port
# list in this script and a different list in the declared policy would let sealed
# evidence assert an egress rule the guest never enforced.
ALLOWED_TCP_PORTS="${EVAL_ALLOWED_TCP_PORTS:-}"

fail() {
  echo "configure-egress: FAILED: $1" >&2
  exit 90
}

command -v iptables >/dev/null 2>&1 || fail "iptables is not installed in this image"
command -v setpriv >/dev/null 2>&1 || fail "setpriv is not installed in this image"

deny_ipv6() {
  # A guest with IPv4 locked and IPv6 open would be trivially able to reach a denied
  # range over the other family. ip6tables may legitimately be absent when the kernel has
  # no IPv6 support at all, which is denial by construction, so that case is tolerated.
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -P OUTPUT DROP || fail "could not deny IPv6 egress"
  else
    echo "configure-egress: ip6tables absent; IPv6 is unavailable in this kernel" >&2
  fi
}

case "$EGRESS_PROFILE" in
  public)
    # Fails CLOSED on a missing or malformed allowlist rather than falling back to a
    # built-in default: a default would be exactly the independent second source of truth
    # this derivation exists to remove.
    case "$ALLOWED_TCP_PORTS" in
      "") fail "EVAL_ALLOWED_TCP_PORTS is required for the public profile and was not set" ;;
      all) ;;
      *[!0-9,]*) fail "EVAL_ALLOWED_TCP_PORTS must be a comma-separated port list: $ALLOWED_TCP_PORTS" ;;
    esac
    # Default-accept plus explicit denials, in this exact order. The denied CIDRs cover
    # loopback, RFC1918 private space, link-local and cloud metadata, and carrier-grade
    # NAT (a sibling-range spelling). The final rule restricts outbound TCP to declared ports
    # when a restricted allowlist is provided; when "all", no multiport restriction is installed.
    iptables -P OUTPUT ACCEPT || fail "could not set the OUTPUT policy"
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 100.64.0.0/10; do
      iptables -A OUTPUT -d "$cidr" -j REJECT || fail "could not deny $cidr"
    done
    if [ "$ALLOWED_TCP_PORTS" != "all" ]; then
      iptables -A OUTPUT -p tcp -m multiport ! --dports "$ALLOWED_TCP_PORTS" -j REJECT \
        || fail "could not restrict outbound TCP to ports $ALLOWED_TCP_PORTS"
    fi
    deny_ipv6
    ;;
  none)
    # The one-shot validator guest: no name resolution, no transport, nothing outbound.
    iptables -P OUTPUT DROP || fail "could not set the OUTPUT policy to DROP"
    deny_ipv6
    ;;
  *)
    fail "unknown EVAL_EGRESS_PROFILE: $EGRESS_PROFILE"
    ;;
esac

# Hand over to the supervisor as the SAME process: no root shell survives, capabilities
# are already dropped by the runtime (--cap-drop ALL), supplementary groups are cleared,
# and no_new_privs is set so a setuid binary can never restore privilege.
exec setpriv --no-new-privs --reuid "$EVAL_UID" --regid "$EVAL_GID" --clear-groups "$@"
