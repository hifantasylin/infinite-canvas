import { useEffect, type ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { loadHostCatalogue, roubaHostConfig } from "@/stores/use-config-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    // Roubaai fork: a hosted canvas reads its model catalogue from the host once,
    // on mount, so no one has to open a settings form to make it usable. A page
    // with no host config is a no-op.
    useEffect(() => {
        void loadHostCatalogue();
    }, []);
    // Roubaai fork: the local-agent panel belongs to the standalone app, where a
    // Codex-backed agent outside the page drives the canvas. A hosted canvas is
    // driven by its host, so the panel is not rendered rather than left showing a
    // connection status nobody can act on.
    const hosted = roubaHostConfig() !== null;
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {hosted ? null : <AgentPanel />}
        </div>
    );
}
