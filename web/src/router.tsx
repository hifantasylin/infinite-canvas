import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import VideoPage from "@/pages/video";

// Roubaai fork: honour the build's base path. Vite rewrites asset URLs for a
// `VITE_BASE` prefix but the browser router does not, so the same build served
// under `/canvas/` matched the root routes and rendered the wrong page (or a 404)
// for every path except the mount point itself.
const baseName = import.meta.env.BASE_URL.replace(/\/+$/, "");

export const router = createBrowserRouter(
    [
        {
            element: (
                <UserLayout>
                    <AnalyticsTracker />
                    <Outlet />
                </UserLayout>
            ),
            children: [
                // Roubaai fork: this canvas is one surface of its host, not a
                // standalone product. The upstream home page (a landing page for
                // the app itself) and its prompt library and settings pages are
                // gone; the project library is the entry, and settings live in
                // the top bar's dialog. `/assets` keeps its route because the
                // canvas' asset picker reads the same store, but it has no nav
                // row of its own.
                { path: "/", element: <Navigate to="/canvas" replace /> },
                { path: "/image", element: <ImagePage /> },
                { path: "/video", element: <VideoPage /> },
                { path: "/assets", element: <AssetsPage /> },
                { path: "/canvas", element: <CanvasPage /> },
                { path: "/canvas/:id", element: <CanvasProjectPage /> },
            ],
        },
        { path: "*", element: <NotFound /> },
    ],
    baseName === "" ? undefined : { basename: baseName },
);
