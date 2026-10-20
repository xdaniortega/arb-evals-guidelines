/** Node-only fail-fast boundary for model completion transport in synthetic execution. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
export const BLOCKED_PROVIDER_HOSTS = [
    "generativelanguage.googleapis.com",
    "aiplatform.googleapis.com",
    "api.anthropic.com",
    "api.openai.com",
];
export class RealCompletionTransportBlockedError extends Error {
    host;
    constructor(host) {
        super(`Real model completion transport to '${host}' is blocked before networking.`);
        this.name = "RealCompletionTransportBlockedError";
        this.host = host;
    }
}
function isBlockedHost(host) {
    if (!host)
        return false;
    const lower = host.toLowerCase().split(":", 1)[0];
    return BLOCKED_PROVIDER_HOSTS.some((blocked) => lower === blocked || lower.endsWith(`.${blocked}`));
}
let installed = false;
/** Install once, before constructing any SDK runtime. Unix-domain fixture sockets remain allowed. */
export function installCompletionTransportBlocker() {
    if (installed)
        return;
    installed = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function guardedFetch(input, init) {
        let hostname;
        try {
            if (typeof input === "string" || input instanceof URL)
                hostname = new URL(input.toString()).hostname;
            else if (input && typeof input === "object" && "url" in input && typeof input.url === "string")
                hostname = new URL(input.url).hostname;
        }
        catch { /* native transport reports malformed URLs */ }
        if (isBlockedHost(hostname))
            throw new RealCompletionTransportBlockedError(hostname ?? "unknown");
        return originalFetch.call(globalThis, input, init);
    };
    const guardRequest = (original) => function guardedRequest(...args) {
        const options = typeof args[0] === "string" || args[0] instanceof URL ? new URL(args[0].toString()) : args[0];
        const host = options?.hostname || options?.host;
        if (isBlockedHost(host))
            throw new RealCompletionTransportBlockedError(host ?? "unknown");
        return original.apply(this, args);
    };
    http.request = guardRequest(http.request);
    https.request = guardRequest(https.request);
    const guardGet = (original) => function guardedGet(...args) {
        const options = typeof args[0] === "string" || args[0] instanceof URL ? new URL(args[0].toString()) : args[0];
        const host = options?.hostname || options?.host;
        if (isBlockedHost(host))
            throw new RealCompletionTransportBlockedError(host ?? "unknown");
        return original.apply(this, args);
    };
    http.get = guardGet(http.get);
    https.get = guardGet(https.get);
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(...args) {
        const first = args[0];
        const options = Array.isArray(first) ? first[0] : first;
        const host = typeof options === "object" && options !== null
            ? options.host ?? options.hostname
            : typeof args[1] === "string" ? args[1] : undefined;
        if (isBlockedHost(host)) {
            const error = new RealCompletionTransportBlockedError(host ?? "unknown");
            process.nextTick(() => this.destroy(error));
            return this;
        }
        return originalConnect.apply(this, args);
    };
}
