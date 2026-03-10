/**
 * channels/channel.ts — Shared channel types.
 *
 * After Chat SDK migration, only media-related types remain here.
 * Message reception and reply delivery are handled by the Chat SDK.
 */

/** A media item to deliver: absolute local file path or http(s) URL. */
export interface MediaItem {
    src: string;
}

/** Returns true when src is an http/https URL rather than a local path. */
export function isMediaUrl(src: string): boolean {
    return src.startsWith('http://') || src.startsWith('https://');
}
