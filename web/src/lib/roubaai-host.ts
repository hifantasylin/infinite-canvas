import axios from "axios";

/**
 * The host context this canvas was opened in.
 *
 * The harness serves the canvas and opens it in a panel for one session; the
 * session id rides the panel URL (`ds`) because the host resolves a request's
 * workspace host-side. A browser that sent a *path* instead would be asking the
 * host to read whatever directory it named, so the wire carries an id and the
 * host owns the lookup.
 */

/** Query parameter naming the session the panel was opened for. */
const SESSION_PARAM = "ds";

/**
 * The session this page load belongs to, captured once.
 *
 * Read at boot rather than per call: the panel opens the canvas with `ds` on its
 * URL, but in-app navigation rewrites that URL without it, and a library that
 * fell back to the shared tree the moment someone clicked a nav row would hide
 * exactly the assets the user came for.
 */
const SESSION = readSessionFromLocation();

/** Read the marker off the current URL, tolerating a non-browser import. */
function readSessionFromLocation(): string {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get(SESSION_PARAM) ?? "";
}

/**
 * The session this canvas belongs to.
 * @returns the session id, or an empty string when the page is not hosted.
 */
export function hostSessionId(): string {
    return SESSION;
}

/**
 * Add the session marker to a host route.
 * @param url - a same-origin host route, with or without its own query.
 * @returns the route with `session` set when this canvas has one.
 */
export function withHostSession(url: string): string {
    const session = hostSessionId();
    if (!session) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}session=${encodeURIComponent(session)}`;
}

/**
 * Send the session on every request to this origin.
 *
 * Installed once by the app entry rather than repeated per call site: the
 * generation routes are built all over the API layer, and a new call that
 * forgot the header would silently bill and land in the wrong workspace.
 */
export function installHostSessionHeader(): void {
    axios.interceptors.request.use((config) => {
        const session = hostSessionId();
        if (!session) return config;
        const url = config.url ?? "";
        // This origin only: a third-party provider API has no business learning
        // which session asked for the work.
        const sameOrigin = url.startsWith("/") || url.startsWith(window.location.origin);
        if (sameOrigin) config.headers.set("x-roubaai-session", session);
        return config;
    });
}
