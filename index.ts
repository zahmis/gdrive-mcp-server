#!/usr/bin/env node

import { authenticate } from "@google-cloud/local-auth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import { google, type drive_v3 } from "googleapis";
import path from "node:path";
import os from "node:os";

const drive = google.drive("v3");

const server = new Server(
  {
    name: "gdrive",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const pageSize = 10;
  const params: drive_v3.Params$Resource$Files$List = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive.files.list(params);
  const files = res.data.files;

  if (!files) {
    return {
      resources: [],
      nextCursor: res.data.nextPageToken,
    };
  }

  return {
    resources: files.map((file) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType,
      name: file.name,
    })),
    nextCursor: res.data.nextPageToken,
  };
});

async function readFileContent(fileId: string) {
  // First get file metadata to check mime type
  const file = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

  // For Google Docs/Sheets/etc we need to export
  if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
    let exportMimeType: string;
    switch (file.data.mimeType) {
      case "application/vnd.google-apps.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.google-apps.spreadsheet":
        exportMimeType = "text/csv";
        break;
      case "application/vnd.google-apps.presentation":
        exportMimeType = "text/plain";
        break;
      case "application/vnd.google-apps.drawing":
        exportMimeType = "image/png";
        break;
      default:
        exportMimeType = "text/plain";
    }

    const res = await drive.files.export(
      { fileId, mimeType: exportMimeType },
      { responseType: "text" }
    );

    return {
      mimeType: exportMimeType,
      content: res.data,
    };
  }

  // For regular files download content
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const mimeType = file.data.mimeType || "application/octet-stream";

  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return {
      mimeType: mimeType,
      content: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
    };
  }
  return {
    mimeType: mimeType,
    content: Buffer.from(res.data as ArrayBuffer).toString("base64"),
  };
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const fileId = request.params.uri.replace("gdrive:///", "");
  const result = await readFileContent(fileId);

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: result.mimeType,
        text: result.content,
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gdrive_search",
        description:
          "Search for files specifically in your Google Drive account (don't use exa nor brave to search for files)",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "gdrive_read_file",
        description:
          "Read a file from Google Drive using its Google Drive file ID (don't use exa nor brave to read files)",
        inputSchema: {
          type: "object",
          properties: {
            file_id: {
              type: "string",
              description: "The ID of the file to read",
            },
          },
          required: ["file_id"],
        },
      },
      {
        name: "gdrive_auth",
        description:
          "Perform authentication flow to generate Google Drive credentials",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "gdrive_search") {
    const userQuery = request.params.arguments?.query as string;
    const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const formattedQuery = `fullText contains '${escapedQuery}'`;

    const res = await drive.files.list({
      q: formattedQuery,
      pageSize: 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
    });

    const fileList = res.data.files
      ?.map(
        (file: drive_v3.Schema$File) =>
          `${file.name} (${file.mimeType}) - ID: ${file.id}`
      )
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Found ${res.data.files?.length ?? 0} files:\n${fileList}`,
        },
      ],
      isError: false,
    };
  }
  if (request.params.name === "gdrive_read_file") {
    const fileId = request.params.arguments?.file_id as string;
    if (!fileId) {
      throw new McpError(ErrorCode.InvalidParams, "File ID is required");
    }

    try {
      const result = await readFileContent(fileId);
      return {
        content: [
          {
            type: "text",
            text: result.content,
          },
        ],
        isError: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error reading file: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
  if (request.params.name === "gdrive_auth") {
    await authenticateAndSaveCredentials();
    return {
      content: [
        { type: "text", text: "Credentials generated and saved successfully." },
      ],
      isError: false,
    };
  }
  throw new Error("Tool not found");
});

const defaultCredentialsDir = path.join(os.homedir(), ".gdrive-mcp-server");
const credentialsPath =
  process.env.MCP_GDRIVE_CREDENTIALS ||
  path.join(defaultCredentialsDir, ".gdrive-server-credentials.json");
// Define path for authentication error logs
const authErrorLogPath = path.join(defaultCredentialsDir, "auth_error.log");

async function authenticateAndSaveCredentials() {
  // Clear previous error log if it exists
  if (fs.existsSync(authErrorLogPath)) {
    fs.unlinkSync(authErrorLogPath);
  }

  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(defaultCredentialsDir, "gcp-oauth.keys.json");

  // Check if key file exists before attempting authentication
  if (!fs.existsSync(keyPath)) {
    const errorMsg = `Error: Key file not found at ${keyPath}. Set GOOGLE_APPLICATION_CREDENTIALS or place it in the default directory.`;
    fs.writeFileSync(authErrorLogPath, errorMsg);
    // Re-throw the error to stop the process and potentially signal failure upstream
    throw new Error(errorMsg);
  }

  if (!fs.existsSync(defaultCredentialsDir)) {
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
  }

  try {
    const auth = await authenticate({
      keyfilePath: keyPath,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials));
  } catch (error) {
    // Log the detailed error to the specified file
    const timestamp = new Date().toISOString();
    const errorDetails =
      error instanceof Error
        ? `${timestamp}: ${error.stack}`
        : `${timestamp}: ${String(error)}`;
    fs.writeFileSync(
      authErrorLogPath,
      `Authentication failed:\n${errorDetails}`
    );
    // Re-throw the error after logging so the calling process knows it failed
    throw error;
  }
}

async function loadCredentialsAndRunServer() {
  if (!fs.existsSync(credentialsPath)) {
    console.warn(
      "Credentials not found. Use the 'gdrive_auth' tool via MCP to authenticate first."
    );
  }
  if (fs.existsSync(credentialsPath)) {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    const auth = new google.auth.OAuth2();
    auth.setCredentials(credentials);
    google.options({ auth });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  authenticateAndSaveCredentials().catch(console.error);
} else {
  loadCredentialsAndRunServer().catch((error) => {
    process.stderr.write(`Error: ${error}\n`);
    process.exit(1);
  });
}
