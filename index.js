import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { google } from "googleapis";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Google Drive client (service-account auth)
// ---------------------------------------------------------------------------
function getDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set. Paste the service-account key JSON into that env var."
    );
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

const bufFromB64 = (b64) => Buffer.from(b64, "base64");
const streamFromBuf = (buf) => Readable.from(buf);
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: `Error: ${msg}` }] });

// ---------------------------------------------------------------------------
// MCP server (fresh instance per request — stateless)
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: "drive-update-mcp", version: "1.0.0" });

  server.registerTool(
    "update_drive_file",
    {
      title: "Update a Google Drive file in place",
      description:
        "Overwrite the contents of an EXISTING Google Drive file, identified by fileId, with new content. The file keeps the same ID, the same shareable link, and Drive retains the previous version in its revision history. Provide the new content base64-encoded. The service account must have Editor access to the file (share the file or its folder with the service-account email).",
      inputSchema: {
        fileId: z.string().describe("The Google Drive file ID to overwrite."),
        contentBase64: z.string().describe("New file content, base64-encoded."),
        mimeType: z
          .string()
          .optional()
          .describe(
            "MIME type of the new content (e.g. application/vnd.openxmlformats-officedocument.wordprocessingml.document for .docx). Defaults to the file's existing type."
          ),
        keepRevisionForever: z
          .boolean()
          .optional()
          .describe("If true, pin this revision permanently in version history."),
      },
    },
    async ({ fileId, contentBase64, mimeType, keepRevisionForever }) => {
      try {
        const drive = getDrive();
        const media = { body: streamFromBuf(bufFromB64(contentBase64)) };
        if (mimeType) media.mimeType = mimeType;
        const res = await drive.files.update({
          fileId,
          media,
          keepRevisionForever: keepRevisionForever || undefined,
          fields: "id,name,mimeType,modifiedTime,size,webViewLink,version",
          supportsAllDrives: true,
        });
        return ok({ updated: true, file: res.data });
      } catch (e) {
        return fail(e?.message || String(e));
      }
    }
  );

  server.registerTool(
    "find_files",
    {
      title: "Find Drive files by name",
      description:
        "Search the Drive accessible to the service account for files whose name contains the query. Use this to resolve a file name to its fileId before calling update_drive_file.",
      inputSchema: {
        query: z.string().describe("Text to match within the file name."),
        pageSize: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, pageSize }) => {
      try {
        const drive = getDrive();
        const escaped = query.replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `name contains '${escaped}' and trashed = false`,
          pageSize: pageSize || 10,
          fields:
            "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          orderBy: "modifiedTime desc",
        });
        return ok(res.data.files || []);
      } catch (e) {
        return fail(e?.message || String(e));
      }
    }
  );

  server.registerTool(
    "create_drive_file",
    {
      title: "Create a new Drive file",
      description:
        "Create a NEW file in Drive from base64 content, optionally inside a folder (parentId). Returns the new file's id and link.",
      inputSchema: {
        name: z.string(),
        contentBase64: z.string(),
        mimeType: z.string(),
        parentId: z.string().optional().describe("Folder ID to create the file in."),
      },
    },
    async ({ name, contentBase64, mimeType, parentId }) => {
      try {
        const drive = getDrive();
        const res = await drive.files.create({
          requestBody: { name, parents: parentId ? [parentId] : undefined },
          media: { mimeType, body: streamFromBuf(bufFromB64(contentBase64)) },
          fields: "id,name,mimeType,webViewLink",
          supportsAllDrives: true,
        });
        return ok(res.data);
      } catch (e) {
        return fail(e?.message || String(e));
      }
    }
  );

  server.registerTool(
    "list_revisions",
    {
      title: "List a file's revision history",
      description: "List the revisions Drive has kept for a file, newest last.",
      inputSchema: { fileId: z.string() },
    },
    async ({ fileId }) => {
      try {
        const drive = getDrive();
        const res = await drive.revisions.list({
          fileId,
          fields: "revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))",
        });
        return ok(res.data.revisions || []);
      } catch (e) {
        return fail(e?.message || String(e));
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP layer (stateless Streamable HTTP) with optional bearer-token gate
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "75mb" })); // large enough for sizeable .docx base64

const AUTH = process.env.MCP_AUTH_TOKEN;
function authorized(req, res) {
  if (!AUTH) return true; // open if no token configured (not recommended for public hosts)
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : (req.query.token || "");
  if (token !== AUTH) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "drive-update-mcp" }));

app.post("/mcp", async (req, res) => {
  if (!authorized(req, res)) return;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e?.message || e) });
  }
});

// Stateless mode: no GET/DELETE session handling
app.get("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`drive-update-mcp listening on :${PORT}`));
