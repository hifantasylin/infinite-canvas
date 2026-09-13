import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Button, Empty, Input, Modal, Select, Spin } from "antd";
import { Check, Download, FileText, Film, FolderInput, Image as ImageIcon, Music, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { createZip, readZip } from "@/lib/zip";
import { withHostSession } from "@/lib/roubaai-host";
import { formatBytes } from "@/lib/image-utils";
import { cn } from "@/lib/utils";

/**
 * Roubaai fork: the asset library browses the host's workspace tree.
 *
 * The upstream page kept its own copy of every asset in browser storage, which
 * nothing outside that browser could read — not the agent, not a generation
 * landing on disk, not a compositing step. Here the tree under
 * `<workspace>/.assets` is the only library, read through the host's
 * `/api/roubaai-assets` routes and written through the same landing path a
 * generated file takes, so an asset added by hand and one produced by a run are
 * the same kind of thing.
 */

const ROUTE = "/api/roubaai-assets";

type Kind = "image" | "video" | "audio" | "other";

type AssetFile = {
    root: string;
    path: string;
    name: string;
    project: string;
    group: string;
    kind: Kind;
    size: number;
    mtime: number;
};

type AssetProject = {
    root: string;
    name: string;
    files: number;
    bytes: number;
    updatedAt: number;
    cover?: string;
};

/** One tree the host serves: the session's workspace, or a mounted library. */
type AssetRoot = {
    id: string;
    writable: boolean;
};

type LibraryAnswer = {
    ok?: boolean;
    roots?: AssetRoot[];
    projects?: AssetProject[];
    files?: AssetFile[];
    error?: string;
};

const KIND_ORDER: Kind[] = ["image", "video", "audio", "other"];

/** The type chips, "all" first. */
const TYPE_FILTERS: Array<Kind | "all"> = ["all", ...KIND_ORDER];

const KIND_ICON = { image: ImageIcon, video: Film, audio: Music, other: FileText } as const;

/** The same-origin URL that serves one asset's bytes, from the tree it lives in. */
function fileUrl(root: string, path: string): string {
    return withHostSession(`${ROUTE}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
}

/** One of a project's bookkeeping files as text, or "" when it is not there. */
async function readText(root: string, path: string): Promise<string> {
    try {
        const response = await fetch(fileUrl(root, path));
        return response.ok ? await response.text() : "";
    } catch {
        return "";
    }
}

/** What landing recorded about one asset, read back out of its project index. */type IndexRow = { category: string; url: string; at: string };

/** The index row whose asset name is this file's, if it has one. */
function indexedRow(index: string, name: string): IndexRow | undefined {
    const line = index.split("\n").find((row) => row.startsWith("|") && row.includes(`| ${name} |`));
    if (line === undefined) return undefined;
    // | 类别 | 资产名 | 路径 | 原始URL | 时间 |
    const cells = line.split("|").map((cell) => cell.trim());
    return { category: cells[1] ?? "", url: (cells[4] ?? "").replaceAll("`", ""), at: cells[5] ?? "" };
}

/** Cost ledger rows this asset's name points at, matched by run label. */
function relatedCost(ledger: string, stem: string): { count: number; cost: number } {
    let count = 0;
    let cost = 0;
    for (const line of ledger.split("\n")) {
        if (line.trim() === "") continue;
        try {
            const entry = JSON.parse(line) as { label?: string; costUsd?: number };
            if (entry.label === undefined || !stem.includes(entry.label)) continue;
            count += 1;
            cost += entry.costUsd ?? 0;
        } catch {
            // A half-written line is not this asset's problem.
        }
    }
    return { count, cost };
}

export default function AssetsPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [files, setFiles] = useState<AssetFile[]>([]);
    const [projects, setProjects] = useState<AssetProject[]>([]);
    const [roots, setRoots] = useState<AssetRoot[]>([]);
    // Which tree is being browsed. The writable one — the session's workspace —
    // comes first, so that is what the page opens on.
    const [rootId, setRootId] = useState("");
    const [project, setProject] = useState("all");
    const [kind, setKind] = useState<Kind | "all">("all");
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState("");
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [preview, setPreview] = useState<AssetFile | null>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetch(withHostSession(`${ROUTE}/library`));
            // Read as text first: a host without this route answers plain text
            // (the static fallback's `not found`), and `response.json()` would
            // surface that as a JSON parse error naming nothing useful.
            const raw = await response.text();
            let body: LibraryAnswer = {};
            try {
                body = JSON.parse(raw) as LibraryAnswer;
            } catch {
                body = {};
            }
            if (!response.ok || body.ok !== true) {
                throw new Error(body.error ?? (response.status === 404 ? t("assets.routeMissing") : `HTTP ${response.status}`));
            }
            setProjects(body.projects ?? []);
            setFiles(body.files ?? []);
            const nextRoots = body.roots ?? [];
            setRoots(nextRoots);
            // Keep the current scope when it still exists; otherwise fall back to
            // the writable tree the host listed first.
            setRootId(current => nextRoots.some(root => root.id === current) ? current : nextRoots[0]?.id ?? "");
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const scope = roots.find(root => root.id === rootId);
    const writable = scope?.writable === true;

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return files.filter((file) => {
            if (file.root !== rootId) return false;
            if (project !== "all" && file.project !== project) return false;
            if (kind !== "all" && file.kind !== kind) return false;
            if (needle === "") return true;
            return `${file.name} ${file.project} ${file.group}`.toLowerCase().includes(needle);
        });
    }, [files, kind, project, query, rootId]);

    /** The projects of the browsed tree, which is what its cards and select show. */
    const scopedProjects = useMemo(() => projects.filter(item => item.root === rootId), [projects, rootId]);

    const groups = useMemo(() => {
        const byGroup = new Map<string, AssetFile[]>();
        for (const file of visible) {
            const list = byGroup.get(file.group) ?? [];
            list.push(file);
            byGroup.set(file.group, list);
        }
        // Unnamed group last, the rest by name so a category reads in tree order.
        return [...byGroup.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "zh-Hans-CN")));
    }, [visible]);

    // The project cards are the library's front door: they show only while the
    // user is looking at everything and has not narrowed by a search.
    const showsProjects = project === "all" && query.trim() === "";

    const toggle = useCallback((key: string) => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    /** The key one file is selected by: its tree plus its path. */
    const fileKey = (file: AssetFile): string => `${file.root}:${file.path}`;

    /** Where an upload goes: the selected project, or one the user names. */
    const pickProject = useCallback((): Promise<string | undefined> => {
        if (project !== "all") return Promise.resolve(project);
        return new Promise((resolve) => {
            let value = scopedProjects[0]?.name ?? "default";
            modal.confirm({
                title: t("assets.chooseProject"),
                content: <Input defaultValue={value} onChange={(event) => { value = event.target.value; }} />,
                okText: t("assets.upload"),
                cancelText: t("common.cancel"),
                onOk: () => { resolve(value.trim() || "default"); },
                onCancel: () => { resolve(undefined); },
            });
        });
    }, [modal, project, scopedProjects, t]);

    const upload = useCallback(async (target: string, list: readonly File[]): Promise<number> => {
        const form = new FormData();
        form.append("project", target);
        for (const file of list) form.append("file", file, file.name);
        const response = await fetch(`${ROUTE}/upload`, { method: "POST", body: form });
        const body = (await response.json()) as { ok?: boolean; error?: string; saved?: unknown[] };
        if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body.saved?.length ?? 0;
    }, [rootId]);

    const addFiles = useCallback(async (list: File[]) => {
        if (list.length === 0) return;
        const target = await pickProject();
        if (target === undefined) return;
        setBusy(true);
        try {
            const count = await upload(target, list);
            message.success(t("assets.uploaded", { count }));
            setProject(target);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.uploadFailed"));
        } finally {
            setBusy(false);
            if (uploadInputRef.current) uploadInputRef.current.value = "";
        }
    }, [load, message, pickProject, t, upload]);

    const importZip = useCallback(async (file: File | undefined) => {
        if (!file) return;
        const target = await pickProject();
        if (target === undefined) {
            if (importInputRef.current) importInputRef.current.value = "";
            return;
        }
        setBusy(true);
        try {
            const entries = await readZip(file);
            const list = [...entries.entries()]
                .filter(([name]) => !name.endsWith("/"))
                .map(([name, blob]) => new File([blob], name.split("/").pop() ?? name, { type: blob.type }));
            if (list.length === 0) throw new Error(t("assets.importEmpty"));
            const count = await upload(target, list);
            message.success(t("assets.imported", { count }));
            setProject(target);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.importFailed"));
        } finally {
            setBusy(false);
            if (importInputRef.current) importInputRef.current.value = "";
        }
    }, [load, message, pickProject, t, upload]);

    const exportSelected = useCallback(async () => {
        const chosen = files.filter((file) => selected.has(fileKey(file)));
        if (chosen.length === 0) return;
        setBusy(true);
        try {
            const entries = await Promise.all(chosen.map(async (file) => {
                const response = await fetch(fileUrl(file.root, file.path));
                if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
                const relative = file.path.slice(file.project.length + 1);
                return { name: `${file.project}/${relative}`, data: await response.blob() };
            }));
            saveAs(await createZip(entries), `roubaai-assets-${chosen.length}.zip`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.exportFailed"));
        } finally {
            setBusy(false);
        }
    }, [files, message, selected, t]);

    /** One write against the browsed tree: move, rename or delete. */
    const edit = useCallback(async (route: string, body: Record<string, unknown>): Promise<void> => {
        const response = await fetch(withHostSession(`${ROUTE}${route}?root=${encodeURIComponent(rootId)}`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const answer = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || answer.ok !== true) throw new Error(answer.error ?? `HTTP ${response.status}`);
    }, [rootId]);

    /** Ask for one value, returning undefined when the dialog is dismissed. */
    const ask = useCallback((title: string, initial: string, okText: string): Promise<string | undefined> => {
        let value = initial;
        return new Promise((resolve) => {
            modal.confirm({
                title,
                content: <Input defaultValue={initial} onChange={(event) => { value = event.target.value; }} />,
                okText,
                cancelText: t("common.cancel"),
                onOk: () => { resolve(value.trim()); },
                onCancel: () => { resolve(undefined); },
            });
        });
    }, [modal, t]);

    /** Run one write over every selected asset, then reload the library. */
    const applyToSelection = useCallback(async (
        run: (file: AssetFile) => Promise<void>,
        done: (count: number) => string,
        failed: string,
    ): Promise<void> => {
        const chosen = files.filter((file) => selected.has(fileKey(file)));
        if (chosen.length === 0) return;
        setBusy(true);
        try {
            for (const file of chosen) await run(file);
            message.success(done(chosen.length));
            setSelected(new Set<string>());
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : failed);
        } finally {
            setBusy(false);
        }
    }, [files, load, message, selected]);

    const moveSelected = useCallback(async () => {
        const first = files.find((file) => selected.has(fileKey(file)));
        if (first === undefined) return;
        const target = await ask(t("assets.moveTitle"), first.project, t("assets.move"));
        if (target === undefined || target === "") return;
        await applyToSelection(
            // Each asset keeps its place below the project: moving a file out of
            // 01_角色 lands it in the target's 01_角色, not at its root.
            (file) => edit("/move", { from: file.path, to: `${target}/${file.path.slice(file.project.length + 1)}` }),
            (count) => t("assets.moved", { count }),
            t("assets.moveFailed"),
        );
    }, [applyToSelection, ask, edit, files, selected, t]);

    const removeSelected = useCallback(async () => {
        const confirmed = await new Promise<boolean>((resolve) => {
            modal.confirm({
                title: t("assets.removeTitle", { count: selected.size }),
                content: t("assets.removeHint"),
                okText: t("assets.remove"),
                okButtonProps: { danger: true },
                cancelText: t("common.cancel"),
                onOk: () => { resolve(true); },
                onCancel: () => { resolve(false); },
            });
        });
        if (!confirmed) return;
        await applyToSelection(
            (file) => edit("/delete", { path: file.path }),
            (count) => t("assets.removed", { count }),
            t("assets.removeFailed"),
        );
    }, [applyToSelection, edit, modal, selected.size, t]);

    const renameAsset = useCallback(async (file: AssetFile) => {
        const name = await ask(t("assets.renameTitle"), file.name, t("assets.rename"));
        if (name === undefined || name === "" || name === file.name) return;
        setBusy(true);
        try {
            await edit("/rename", { path: file.path, name });
            message.success(t("assets.renamed"));
            setPreview(null);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.renameFailed"));
        } finally {
            setBusy(false);
        }
    }, [ask, edit, load, message, t]);

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto w-full max-w-6xl px-6 py-10">
                <header className="text-center">
                    <h1 className="text-3xl font-semibold">{t("assets.title")}</h1>
                    <p className="mt-3 text-sm text-stone-500">{t("assets.description")}</p>
                </header>

                <div className="mx-auto mt-8 flex max-w-3xl items-stretch">
                    <Input
                        size="large"
                        allowClear
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onPressEnter={() => setQuery(draft)}
                        placeholder={t("assets.search")}
                        prefix={<Search className="size-4 text-stone-400" />}
                        className="!rounded-r-none"
                    />
                    <Button size="large" type="primary" className="!h-auto shrink-0 !rounded-l-none" icon={<Search className="size-4" />} onClick={() => setQuery(draft)} aria-label={t("assets.searchAction")} />
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                    {/* Which tree is being browsed. The session's workspace is
                        this project's own assets; the mounted library is the
                        cross-project store, and it is read-only. */}
                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-stone-500">{t("assets.scope")}</span>
                        <div className="flex flex-wrap items-center gap-1">
                            {roots.map((root) => (
                                <button
                                    key={root.id}
                                    type="button"
                                    onClick={() => { setRootId(root.id); setProject("all"); }}
                                    className={cn(
                                        "rounded-full px-3 py-1 text-sm transition",
                                        rootId === root.id
                                            ? "bg-stone-950 font-medium dark:bg-stone-100"
                                            : "hover:bg-stone-100 dark:hover:bg-stone-800",
                                    )}
                                >
                                    <span className={rootId === root.id ? "text-white dark:text-stone-950" : "text-stone-600 dark:text-stone-300"}>
                                        {t(root.id === "workspace" ? "assets.scopeWorkspace" : "assets.scopeGlobal")}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm">
                        <span className="text-stone-500">{t("assets.project")}</span>
                        <Select
                            value={project}
                            onChange={setProject}
                            className="min-w-40"
                            options={[{ value: "all", label: t("assets.projectAll") }, ...scopedProjects.map((item) => ({ value: item.name, label: item.name }))]}
                        />
                    </label>

                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-stone-500">{t("assets.type")}</span>
                        <div className="flex flex-wrap items-center gap-1">
                            {TYPE_FILTERS.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setKind(value)}
                                    className={cn(
                                        "rounded-full px-3 py-1 text-sm transition",
                                        kind === value
                                            ? "bg-stone-950 font-medium dark:bg-stone-100"
                                            : "hover:bg-stone-100 dark:hover:bg-stone-800",
                                    )}
                                >
                                    {/* The colour rides a span: the form reset
                                        (`input, button, … { color: inherit }`) is
                                        unlayered, so it outranks every Tailwind
                                        text utility on the button itself. */}
                                    <span className={kind === value ? "text-white dark:text-stone-950" : "text-stone-600 dark:text-stone-300"}>
                                        {value === "all" ? t("assets.typeAll") : t(`assets.kind.${value}`)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="ml-auto flex items-center gap-2">
                        <Button disabled={busy} onClick={() => void load()}>{t("assets.refresh")}</Button>
                        <Button icon={<Download className="size-4" />} disabled={busy || selected.size === 0} onClick={() => void exportSelected()}>
                            {t("assets.export")}
                        </Button>
                        <Button icon={<Upload className="size-4" />} disabled={busy || !writable} title={writable ? undefined : t("assets.readOnly")} onClick={() => importInputRef.current?.click()}>
                            {t("assets.import")}
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} disabled={busy || !writable} title={writable ? undefined : t("assets.readOnly")} onClick={() => uploadInputRef.current?.click()}>
                            {t("assets.add")}
                        </Button>
                    </div>
                </div>

                {selected.size > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-stone-100 px-4 py-2 text-sm dark:bg-stone-900">
                        <span>{t("assets.selectedCount", { count: selected.size })}</span>
                        <Button size="small" icon={<FolderInput className="size-3.5" />} disabled={busy || !writable} title={writable ? undefined : t("assets.readOnly")} onClick={() => void moveSelected()}>
                            {t("assets.move")}
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={busy || !writable} title={writable ? undefined : t("assets.readOnly")} onClick={() => void removeSelected()}>
                            {t("assets.remove")}
                        </Button>
                        <Button size="small" onClick={() => setSelected(new Set<string>())}>{t("assets.clearSelection")}</Button>
                    </div>
                ) : null}

                {loading ? (
                    <div className="grid min-h-[320px] place-items-center"><Spin /></div>
                ) : showsProjects ? (
                    scopedProjects.length === 0 ? (
                        <section className="grid min-h-[320px] place-items-center text-center">
                            <div>
                                <h2 className="text-lg font-medium">{t("assets.emptyLibrary")}</h2>
                                <p className="mt-2 text-sm text-stone-500">{t("assets.emptyLibraryHint")}</p>
                            </div>
                        </section>
                    ) : (
                        <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                            {scopedProjects.map((item) => (
                                <button
                                    key={`${item.root}/${item.name}`}
                                    type="button"
                                    onClick={() => setProject(item.name)}
                                    className="overflow-hidden rounded-xl border border-stone-200 text-left transition hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
                                >
                                    <span className="block aspect-[4/3] w-full bg-stone-100 dark:bg-stone-900">
                                        {item.cover ? (
                                            <img src={fileUrl(item.root, item.cover)} alt="" loading="lazy" className="size-full object-cover" />
                                        ) : (
                                            <span className="grid size-full place-items-center text-stone-400"><ImageIcon className="size-8" /></span>
                                        )}
                                    </span>
                                    <span className="block px-4 py-3">
                                        <span className="block truncate text-sm font-medium">{item.name}</span>
                                        <span className="mt-1 block text-xs text-stone-500">
                                            {t("assets.projectSummary", { count: item.files, size: formatBytes(item.bytes) })}
                                        </span>
                                    </span>                                </button>
                            ))}
                        </div>
                    )
                ) : visible.length === 0 ? (
                    <div className="grid min-h-[280px] place-items-center">
                        <Empty description={t("assets.empty")} />
                    </div>
                ) : (
                    <div className="mt-6 space-y-8">
                        {groups.map(([group, list]) => (
                            <section key={group === "" ? "__ungrouped" : group}>
                                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-stone-500">
                                    {group === "" ? t("assets.uncategorized") : group}
                                    <span className="text-xs text-stone-400">{list.length}</span>
                                </h2>
                                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                                    {list.map((file) => (
                                        <AssetCard
                                            key={fileKey(file)}
                                            file={file}
                                            selected={selected.has(fileKey(file))}
                                            onToggle={() => toggle(fileKey(file))}
                                            onPreview={() => setPreview(file)}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>

            <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept="image/*,video/*,audio/*"
                className="hidden"
                onChange={(event) => void addFiles([...(event.target.files ?? [])])}
            />
            <input
                ref={importInputRef}
                type="file"
                accept="application/zip,.zip"
                className="hidden"
                onChange={(event) => void importZip(event.target.files?.[0])}
            />
            <AssetPreview file={preview} writable={writable} onRename={renameAsset} onClose={() => setPreview(null)} />
        </main>
    );
}

/** One asset tile: the frame previews, the corner box selects. */
function AssetCard({ file, selected, onToggle, onPreview }: {
    file: AssetFile;
    selected: boolean;
    onToggle: () => void;
    onPreview: () => void;
}) {
    const Icon = KIND_ICON[file.kind];
    return (
        <div className="group relative">
            <button type="button" onClick={onPreview} className="block w-full text-left">
                <span className="block aspect-square w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900">
                    {file.kind === "image" ? (
                        <img src={fileUrl(file.root, file.path)} alt={file.name} loading="lazy" className="size-full object-cover" />
                    ) : file.kind === "video" ? (
                        <video src={fileUrl(file.root, file.path)} muted preload="metadata" className="size-full object-cover" />
                    ) : (
                        <span className="grid size-full place-items-center text-stone-400"><Icon className="size-7" /></span>
                    )}
                </span>
                <span className="mt-2 block truncate text-sm" title={file.path}>{file.name}</span>
                <span className="mt-0.5 block text-xs text-stone-500">{formatBytes(file.size)}</span>
            </button>
            <button
                type="button"
                onClick={onToggle}
                aria-label={file.name}
                className={cn(
                    "absolute left-2 top-2 grid size-5 place-items-center rounded border transition",
                    selected
                        ? "border-stone-950 bg-stone-950 dark:border-stone-100 dark:bg-stone-100"
                        : "border-stone-300 bg-white/80 opacity-0 group-hover:opacity-100 dark:border-stone-600 dark:bg-stone-900/80",
                )}
            >
                {/* Colour on the glyph, for the same reason as the type chips. */}
                <Check className={cn("size-3.5", selected ? "text-white dark:text-stone-950" : "text-transparent")} />
            </button>
        </div>
    );
}

/** One labelled fact in the detail list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex gap-3">
            <span className="w-20 shrink-0 text-stone-500">{label}</span>
            <span className="min-w-0 break-all">{children}</span>
        </div>
    );
}

/**
 * What the tree knows about one asset: where it sits, what landed it, and the
 * cost rows its name points at.
 *
 * The index and the ledger are read on open rather than with the library: they
 * are bookkeeping files, the library does not list them, and a page that fetched
 * them for every asset would read the same two files hundreds of times.
 */
function AssetDetail({ file }: { file: AssetFile }) {
    const { t } = useTranslation();
    const [detail, setDetail] = useState<{ row: IndexRow | undefined; cost: { count: number; cost: number } } | null>(null);

    useEffect(() => {
        let live = true;
        setDetail(null);
        void (async () => {
            const [index, ledger] = await Promise.all([
                readText(file.root, `${file.project}/assets-index.md`),
                readText(file.root, `${file.project}/media-cost.jsonl`),
            ]);
            if (!live) return;
            setDetail({ row: indexedRow(index, file.name), cost: relatedCost(ledger, file.name.replace(/\.[^.]+$/, "")) });
        })();
        return () => { live = false; };
    }, [file]);

    return (
        <div className="mt-4 space-y-2 border-t border-stone-200 pt-4 text-sm dark:border-stone-800">
            <Fact label={t("assets.detailPath")}>{file.path}</Fact>
            <Fact label={t("assets.detailSize")}>{formatBytes(file.size)}</Fact>
            <Fact label={t("assets.detailModified")}>{new Date(file.mtime).toLocaleString()}</Fact>
            <Fact label={t("assets.detailSource")}>
                {detail === null ? "…" : detail.row === undefined ? (
                    <span className="text-stone-500">{t("assets.detailSourceNone")}</span>
                ) : (
                    <>
                        {detail.row.category}
                        {detail.row.at === "" ? "" : ` · ${detail.row.at}`}
                    </>
                )}
            </Fact>
            <Fact label={t("assets.detailOrigin")}>
                {detail?.row?.url === undefined || detail.row.url === "" ? (
                    <span className="text-stone-500">{t("assets.detailOriginNone")}</span>
                ) : (
                    <a className="underline" href={detail.row.url} target="_blank" rel="noopener noreferrer">{detail.row.url}</a>
                )}
            </Fact>
            <Fact label={t("assets.detailCost")}>
                {detail === null ? "…" : detail.cost.count === 0 ? (
                    <span className="text-stone-500">{t("assets.detailCostNone")}</span>
                ) : (
                    t("assets.detailCostValue", { count: detail.cost.count, cost: detail.cost.cost.toFixed(4) })
                )}
            </Fact>
        </div>
    );
}

/** The preview dialog: the asset at its own scale, straight from the file route. */
function AssetPreview({ file, writable, onRename, onClose }: {
    file: AssetFile | null;
    writable: boolean;
    onRename: (file: AssetFile) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Modal
            open={file !== null}
            onCancel={onClose}
            footer={file !== null && writable ? (
                <Button icon={<Pencil className="size-4" />} onClick={() => onRename(file)}>{t("assets.rename")}</Button>
            ) : null}
            width={880}
            centered
            title={file?.name}
        >
            {file === null ? null : (
                <>
                    {file.kind === "image" ? (
                        <img src={fileUrl(file.root, file.path)} alt={file.name} className="max-h-[65vh] w-full object-contain" />
                    ) : file.kind === "video" ? (
                        <video src={fileUrl(file.root, file.path)} controls autoPlay className="max-h-[65vh] w-full" />
                    ) : file.kind === "audio" ? (
                        <audio src={fileUrl(file.root, file.path)} controls className="w-full" />
                    ) : (
                        <a className="text-sm underline" href={fileUrl(file.root, file.path)} target="_blank" rel="noopener noreferrer">{t("assets.openRaw")}</a>
                    )}
                    <AssetDetail file={file} />
                </>
            )}
        </Modal>
    );
}
