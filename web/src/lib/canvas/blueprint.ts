import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";

/**
 * Roubaai fork: read a production blueprint and turn it into canvas ops.
 *
 * A blueprint is a small JSON file in the project's asset directory
 * (`<workspace>/.assets/<project>/canvas-blueprint.json`) describing the plan the
 * host produced: nodes with a type, a title, a prompt and a URL, plus pairs of
 * connections. Realising it through the canvas's own op pipeline (the same one the
 * agent bridge uses) is what keeps the result a normal, editable canvas — the
 * lines are visible, the prompts are on the nodes, and nothing is hidden state.
 *
 * Positions come from a stage layout (text → image → video) rather than from the
 * file: a plan describes intent, not pixels. This mapping is duplicated verbatim
 * in the node plugin (`@roubaai/canvas` assets), which must stay self-contained;
 * change both together.
 */

/** Route the host serves the asset tree on. */
export const ASSET_FILE_ROUTE = "/api/roubaai-assets/file";
/** Route listing the projects that carry a blueprint, newest first. */
export const ASSET_BLUEPRINTS_ROUTE = "/api/roubaai-assets/blueprints";

/** Stage per node type: the column a node lands in, left to right. */
const STAGES: Record<string, number> = { text: 0, config: 0, image: 1, video: 2, audio: 2 };
const COLUMN_WIDTH = 380;
const ROW_HEIGHT = 260;

type BlueprintNode = { id?: unknown; type?: unknown; title?: unknown; content?: unknown; url?: unknown; prompt?: unknown; model?: unknown; size?: unknown; quality?: unknown; count?: unknown };
type Blueprint = { nodes?: unknown; connections?: unknown };

/** The URL that serves one project's blueprint file. */
export function blueprintUrl(project: string) {
    return `${ASSET_FILE_ROUTE}?path=${encodeURIComponent(`${project}/canvas-blueprint.json`)}`;
}

/** Only the metadata each node type actually reads, so nothing invents a field. */
function metadataFor(type: string, entry: BlueprintNode): Record<string, unknown> {
    const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
    if (type === "text") return { content: typeof entry.content === "string" ? entry.content : "" };
    if (type === "image") return { content: typeof entry.url === "string" ? entry.url : "", prompt };
    if (type === "video") return { prompt };
    if (type === "audio") return { content: typeof entry.url === "string" ? entry.url : "", prompt };
    if (type === "config") {
        return {
            ...(typeof entry.model === "string" ? { model: entry.model } : {}),
            ...(typeof entry.size === "string" ? { size: entry.size } : {}),
            ...(typeof entry.quality === "string" ? { quality: entry.quality } : {}),
            ...(entry.count === undefined ? {} : { count: Number(entry.count) || 1 }),
        };
    }
    return {};
}

/**
 * Turn a parsed blueprint into the ops that realise it.
 * @param blueprint - the parsed blueprint file.
 * @param origin - where the first column starts.
 * @returns the ops to hand to the canvas's op applier.
 */
export function blueprintOps(blueprint: Blueprint, origin = { x: 0, y: 0 }): CanvasAgentOp[] {
    const ops: CanvasAgentOp[] = [];
    const ids = new Map<string, string>();
    const rows: Record<number, number> = {};
    const nodes = Array.isArray(blueprint.nodes) ? (blueprint.nodes as BlueprintNode[]) : [];
    // A per-application stamp keeps two applications of one blueprint from
    // colliding on node ids.
    const stamp = Math.random().toString(36).slice(2, 7);
    nodes.forEach((entry, index) => {
        const name = typeof entry?.id === "string" && entry.id ? entry.id : `node-${index + 1}`;
        const type = typeof entry?.type === "string" && entry.type ? entry.type : "text";
        const stage = STAGES[type] ?? 1;
        const row = rows[stage] ?? 0;
        rows[stage] = row + 1;
        const id = `bp-${stamp}-${name}`;
        ids.set(name, id);
        ops.push({
            type: "add_node",
            id,
            nodeType: type,
            title: typeof entry?.title === "string" && entry.title ? entry.title : name,
            position: { x: origin.x + stage * COLUMN_WIDTH, y: origin.y + row * ROW_HEIGHT },
            metadata: metadataFor(type, entry) as never,
        });
    });
    const connections = Array.isArray(blueprint.connections) ? (blueprint.connections as unknown[]) : [];
    for (const pair of connections) {
        if (!Array.isArray(pair)) continue;
        const from = ids.get(String(pair[0]));
        const to = ids.get(String(pair[1]));
        if (from !== undefined && to !== undefined) ops.push({ type: "connect_nodes", fromNodeId: from, toNodeId: to });
    }
    return ops;
}

/**
 * Fetch one project's blueprint.
 * @param project - the `.assets` project folder name.
 * @returns the parsed blueprint, or null when the project has none.
 */
export async function fetchBlueprint(project: string): Promise<Blueprint | null> {
    try {
        const response = await fetch(blueprintUrl(project));
        if (!response.ok) return null;
        return (await response.json()) as Blueprint;
    } catch {
        return null;
    }
}

/** One project that carries a blueprint, as the host lists them. */
export type BlueprintEntry = { project: string; mtime: number; bytes: number };

/**
 * The newest blueprint the host knows about, if any.
 *
 * An empty canvas should come up with the plan that was just written rather than
 * with nothing, and that plan is the newest one — the host produces a blueprint
 * for the work at hand, not a library of them.
 * @returns the newest project name, or null when no project has a blueprint.
 */
export async function newestBlueprint(): Promise<BlueprintEntry | null> {
    try {
        const response = await fetch(ASSET_BLUEPRINTS_ROUTE);
        if (!response.ok) return null;
        const payload = (await response.json()) as { blueprints?: BlueprintEntry[] };
        return payload.blueprints?.[0] ?? null;
    } catch {
        return null;
    }
}
