// Chat archive: gzipped + base64 for zero-dependency shipping.
// EMPTY by default (an empty message list). Populate it from your own group
// export with `scripts/reingest-archive.ts` — see scripts/README.md.
// `search-chat` also merges the bridge's live tail at query time, so the bot
// still works on recent messages before you ever bake an archive.
export const CHAT_GZIP_B64 = "H4sIAAAAAAAAE4uOBQApu0wNAgAAAA==";
