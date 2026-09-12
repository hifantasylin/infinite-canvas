import { useEffect, type ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { loadHostCatalogue } from "@/stores/use-config-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    // Roubaai fork: a hosted canvas reads its model catalogue from the host once,
    // on mount, so no one has to open a settings form to make it usable. A page
    // with no host config is a no-op.
    useEffect(() => {
        void loadHostCatalogue();
    }, []);
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}
