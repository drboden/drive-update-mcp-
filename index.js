import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { google } from "googleapis";
import { Readable } from "node:stream";

function makeAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set.");
  let creds;
  try { creds = JSON.parse(raw); }
  catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/presentations",
    ],
  });
}
const getDrive = () => google.drive({ version: "v3", auth: makeAuth() });
const getDocs = () => google.docs({ version: "v1", auth: makeAuth() });
const getSlides = () => google.slides({ version: "v1", auth: makeAuth() });

const bufFromB64 = (b64) => Buffer.from(b64, "base64");
const streamFromBuf = (buf) => Readable.from(buf);
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: "Error: " + msg }] });

function docToText(content = []) {
  let out = "";
  const walk = (els) => {
    for (const el of els) {
      if (el.paragraph) {
        for (const e of el.paragraph.elements || []) {
          if (e.textRun && e.textRun.content) out += e.textRun.content;
        }
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content || []);
        }
      }
    }
  };
  walk(content);
  return out;
}

function buildServer() {
  const server = new McpServer({ name: "drive-update-mcp", version: "1.2.0" });

  server.registerTool("find_files", {
    title: "Find Drive files by name",
    description: "Search the Drive accessible to the service account for files whose name contains the query. Returns id, name, mimeType, link.",
    inputSchema: { query: z.string(), pageSize: z.number().int().min(1).max(50).optional() },
  }, async ({ query, pageSize }) => {
    try {
      const drive = getDrive();
      const escaped = query.replace(/'/g, "\\'");
      const res = await drive.files.list({
        q: "name contains '" + escaped + "' and trashed = false",
        pageSize: pageSize || 10,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
        supportsAllDrives: true, includeItemsFromAllDrives: true, orderBy: "modifiedTime desc",
      });
      return ok(res.data.files || []);
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("get_doc_text", {
    title: "Read a Google Doc's text",
    description: "Return the plain text of a Google Doc (by its fileId / documentId) so you can see the exact current wording before making targeted edits.",
    inputSchema: { documentId: z.string() },
  }, async ({ documentId }) => {
    try {
      const docs = getDocs();
      const res = await docs.documents.get({ documentId });
      return ok({ documentId, title: res.data.title, text: docToText(res.data.body && res.data.body.content) });
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("replace_text_in_doc", {
    title: "Edit a Google Doc in place (find & replace)",
    description: "Make targeted text edits to an EXISTING Google Doc in place, WITHOUT re-uploading the file. Each replacement swaps every occurrence of find with replace. The document keeps its ID, link, formatting, images and layout. Call get_doc_text first to copy exact wording.",
    inputSchema: {
      documentId: z.string(),
      replacements: z.array(z.object({
        find: z.string(), replace: z.string(), matchCase: z.boolean().optional(),
      })).min(1),
    },
  }, async ({ documentId, replacements }) => {
    try {
      const docs = getDocs();
      const requests = replacements.map((r) => ({
        replaceAllText: { containsText: { text: r.find, matchCase: r.matchCase !== false }, replaceText: r.replace },
      }));
      const res = await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
      const changed = (res.data.replies || []).map((rep, i) => ({
        find: replacements[i].find,
        occurrencesChanged: (rep.replaceAllText && rep.replaceAllText.occurrencesChanged) || 0,
      }));
      return ok({ documentId, changed });
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("get_slides_text", {
    title: "Read a Google Slides deck's text",
    description: "Return the text of a Google Slides presentation (by its fileId / presentationId), grouped by slide, with each slide's objectId and each text shape's objectId — so you can see exact wording and target edits before changing anything.",
    inputSchema: { presentationId: z.string() },
  }, async ({ presentationId }) => {
    try {
      const slides = getSlides();
      const res = await slides.presentations.get({ presentationId });
      const readShapeText = (shape) => {
        if (!shape || !shape.text) return "";
        return (shape.text.textElements || [])
          .map((t) => (t.textRun && t.textRun.content) || "")
          .join("");
      };
      const out = (res.data.slides || []).map((slide, i) => {
        const lines = [`--- Slide ${i + 1} (id: ${slide.objectId}) ---`];
        for (const el of slide.pageElements || []) {
          const direct = readShapeText(el.shape).trim();
          if (direct) lines.push(`[${el.objectId}] ${direct}`);
          if (el.table) {
            for (const row of el.table.tableRows || []) {
              for (const cell of row.tableCells || []) {
                const cellText = readShapeText({ text: cell.text }).trim();
                if (cellText) lines.push(`[${el.objectId} table] ${cellText}`);
              }
            }
          }
        }
        return lines.join("\n");
      });
      return ok({ presentationId, title: res.data.title, text: out.join("\n\n") });
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("replace_text_in_slides", {
    title: "Edit a Google Slides deck in place (find & replace)",
    description: "Make targeted text edits to an EXISTING Google Slides presentation in place, WITHOUT re-uploading. Each replacement swaps every occurrence of find with replace, keeping the deck's ID, link, formatting and layout. Optionally limit the replace to specific slides by passing their objectIds in pageObjectIds. Call get_slides_text first to copy exact wording and IDs.",
    inputSchema: {
      presentationId: z.string(),
      replacements: z.array(z.object({
        find: z.string(), replace: z.string(), matchCase: z.boolean().optional(),
      })).min(1),
      pageObjectIds: z.array(z.string()).optional(),
    },
  }, async ({ presentationId, replacements, pageObjectIds }) => {
    try {
      const slides = getSlides();
      const requests = replacements.map((r) => {
        const req = {
          replaceAllText: {
            containsText: { text: r.find, matchCase: r.matchCase !== false },
            replaceText: r.replace,
          },
        };
        if (pageObjectIds && pageObjectIds.length) req.replaceAllText.pageObjectIds = pageObjectIds;
        return req;
      });
      const res = await slides.presentations.batchUpdate({ presentationId, requestBody: { requests } });
      const changed = (res.data.replies || []).map((rep, i) => ({
        find: replacements[i].find,
        occurrencesChanged: (rep.replaceAllText && rep.replaceAllText.occurrencesChanged) || 0,
      }));
      return ok({ presentationId, changed });
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("update_drive_file", {
    title: "Overwrite a Drive file in place (whole file)",
    description: "Overwrite the entire contents of an existing Drive file by fileId with new base64 content. Best for small, non-Google-Doc files. For text edits to a Google Doc, prefer replace_text_in_doc.",
    inputSchema: { fileId: z.string(), contentBase64: z.string(), mimeType: z.string().optional(), keepRevisionForever: z.boolean().optional() },
  }, async ({ fileId, contentBase64, mimeType, keepRevisionForever }) => {
    try {
      const drive = getDrive();
      const media = { body: streamFromBuf(bufFromB64(contentBase64)) };
      if (mimeType) media.mimeType = mimeType;
      const res = await drive.files.update({
        fileId, media, keepRevisionForever: keepRevisionForever || undefined,
        fields: "id,name,mimeType,modifiedTime,webViewLink,version", supportsAllDrives: true,
      });
      return ok({ updated: true, file: res.data });
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  server.registerTool("list_revisions", {
    title: "List a file's revision history",
    description: "List the revisions Drive has kept for a file, newest last.",
    inputSchema: { fileId: z.string() },
  }, async ({ fileId }) => {
    try {
      const drive = getDrive();
      const res = await drive.revisions.list({ fileId, fields: "revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))" });
      return ok(res.data.revisions || []);
    } catch (e) { return fail((e && e.message) || String(e)); }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "75mb" }));

const AUTH = process.env.MCP_AUTH_TOKEN;
function authorized(req, res) {
  if (!AUTH) return true;
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token || "");
  if (token !== AUTH) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "drive-update-mcp" }));

app.post("/mcp", async (req, res) => {
  if (!authorized(req, res)) return;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("drive-update-mcp listening on :" + PORT));
