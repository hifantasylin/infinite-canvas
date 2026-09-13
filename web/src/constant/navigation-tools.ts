import { ImagePlus, Maximize2, Video } from "lucide-react";

/**
 * Roubaai fork: the top bar's tool rows. The upstream list also carried the
 * prompt library and the settings page — the first is reachable inside a canvas
 * (its side panel reads the same sources) and the second duplicates the top
 * bar's settings dialog, so neither earns a row.
 */
export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
