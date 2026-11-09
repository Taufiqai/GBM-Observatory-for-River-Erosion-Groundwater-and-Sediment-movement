// api/_store.js — tiny wrapper around Vercel Blob for the pilot logs.
// Files whose name starts with "_" are not exposed as routes by Vercel.
// Everything degrades gracefully: if no Blob store is connected, configured() is false and
// callers say so plainly instead of pretending to have saved anything.

let _lib = null;
const lib = () => (_lib || (_lib = require("@vercel/blob")));

function configured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

// Prefer private blobs; fall back to an unguessable public URL if the store is public-only.
async function putJSON(pathname, obj, opts) {
  const o = opts || {};
  const body = JSON.stringify(obj);
  const base = { contentType: "application/json", allowOverwrite: !!o.overwrite };
  try {
    return await lib().put(pathname, body, Object.assign({ access: "private", addRandomSuffix: !o.overwrite && !!o.random }, base));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/access|private|public/i.test(msg)) {
      return await lib().put(pathname, body, Object.assign({ access: "public", addRandomSuffix: true }, base));
    }
    throw e;
  }
}

async function listAll(prefix, max) {
  const out = []; let cursor;
  do {
    const r = await lib().list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor && out.length < (max || 5000));
  return out;
}

async function readJSON(blob) {
  for (const access of ["private", "public"]) {
    try {
      const r = await lib().get(blob.url || blob.pathname, { access, useCache: false });
      if (r && r.stream) return JSON.parse(await new Response(r.stream).text());
    } catch (e) { /* try the other access mode */ }
  }
  return null;
}

module.exports = { configured, putJSON, listAll, readJSON };
