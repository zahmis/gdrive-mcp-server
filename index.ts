#!/usr/bin/env node

import { authenticate } from "@google-cloud/local-auth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import { google } from "googleapis";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const drive = google.drive("v3");

// サーバーをMcpServerからServerに戻す（既存コードとの互換性のため）
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
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const pageSize = 10;
  const params: any = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive.files.list(params);
  const files = res.data.files!;

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
      { responseType: "text" },
    );

    return {
      mimeType: exportMimeType,
      content: res.data,
    };
  }

  // For regular files download content
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  const mimeType = file.data.mimeType || "application/octet-stream";
  
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return {
      mimeType: mimeType,
      content: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
    };
  } else {
    return {
      mimeType: mimeType,
      content: Buffer.from(res.data as ArrayBuffer).toString("base64"),
    };
  }
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
        description: "Search for files specifically in your Google Drive account (don't use exa nor brave to search for files)",
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
        description: "Read a file from Google Drive using its Google Drive file ID (don't use exa nor brave to read files)",
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
      ?.map((file: any) => `${file.name} (${file.mimeType}) - ID: ${file.id}`)
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
  } else if (request.params.name === "gdrive_read_file") {
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
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
  throw new Error("Tool not found");
});

const credentialsPath = process.env.MCP_GDRIVE_CREDENTIALS || path.join(process.cwd(), "credentials", ".gdrive-server-credentials.json");

async function authenticateAndSaveCredentials() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(process.cwd(), "credentials", "gcp-oauth.keys.json");
  
  console.log("Looking for keys at:", keyPath);
  console.log("Will save credentials to:", credentialsPath);
  
  const auth = await authenticate({
    keyfilePath: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  
  fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials));
  console.log("Credentials saved. You can now run the server.");
}

// HTTP/SSEサーバーの設定
function setupHttpServer() {
  console.log("Setting up HTTP/SSE server...");
  const app = express();
  app.use(express.json());
  
  // Store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
  console.log("Initialized transports map");

  //=============================================================================
  // STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
  //=============================================================================
  app.all('/mcp', async (req, res) => {
    console.log(`Received ${req.method} request to /mcp with headers:`, req.headers);
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string;
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transports[sessionId]) {
        console.log(`Reusing existing transport for session ${sessionId}`);
        // Check if the transport is of the correct type
        const existingTransport = transports[sessionId];
        if (existingTransport instanceof StreamableHTTPServerTransport) {
          // Reuse existing transport
          transport = existingTransport;
        } else {
          // Transport exists but is not a StreamableHTTPServerTransport
          console.error(`Session ${sessionId} exists but uses a different transport protocol`);
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Session exists but uses a different transport protocol',
            },
            id: null,
          });
          return;
        }
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        console.log("Creating new StreamableHTTPServerTransport for initialization request");
        // Create new transport for initialization request
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            // Store the transport by session ID when session is initialized
            console.log(`StreamableHTTP session initialized with ID: ${sid}`);
            if (newTransport?.sessionId) {
              transports[sid] = newTransport;
            }
          }
        });
        
        transport = newTransport;

        // Set up onclose handler to clean up transport when closed
        transport.onclose = () => {
          if (transport?.sessionId && transports[transport.sessionId]) {
            console.log(`Transport closed for session ${transport.sessionId}, removing from transports map`);
            delete transports[transport.sessionId];
          }
        };

        // Connect the transport to the server
        await server.connect(transport);
        console.log("Server connected to new transport");
      } else {
        // Invalid request - no session ID or not initialization request
        console.error("Invalid request: No valid session ID provided and not an initialization request");
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request with the transport
      if (transport) {
        console.log(`Handling request with transport for session ${transport.sessionId}`);
        await transport.handleRequest(req, res, req.body);
      } else {
        console.error("Transport not available");
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error: Transport not available',
          },
          id: null,
        });
      }
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  //=============================================================================
  // DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
  //=============================================================================
  app.get('/sse', async (req, res) => {
    console.log('Received GET request to /sse (deprecated SSE transport) with headers:', req.headers);
    
    try {
      // SSEServerTransportを作成
      console.log('Creating new SSEServerTransport');
      const transport = new SSEServerTransport('/messages', res);
      
      // transportをstoreに保存
      console.log(`Storing SSE transport with session ID: ${transport.sessionId}`);
      transports[transport.sessionId] = transport;
      
      // クリーンアップ処理
      res.on("close", () => {
        console.log(`Cleaning up SSE transport for session ${transport.sessionId}`);
        delete transports[transport.sessionId];
      });
      
      // サーバーに接続（これにより内部的にtransport.start()が呼ばれる）
      console.log('Connecting SSE transport to server');
      await server.connect(transport);
      console.log(`SSE transport connected, session: ${transport.sessionId}`);
    } catch (error) {
      console.error('Error handling SSE connection:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  app.post('/messages', async (req, res) => {
    console.log('Received POST request to /messages with query:', req.query, 'body:', req.body);
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
      console.error('Missing sessionId parameter in request');
      res.status(400).send('Missing sessionId parameter');
      return;
    }
    
    console.log(`Looking for transport with session ID: ${sessionId}`);
    const existingTransport = transports[sessionId];
    if (!existingTransport) {
      console.error(`No transport found for sessionId: ${sessionId}`);
      res.status(400).send('No transport found for sessionId');
      return;
    }
    
    if (existingTransport instanceof SSEServerTransport) {
      console.log(`Handling POST message for SSE transport session: ${sessionId}`);
      // SSEServerTransportに対するhandlePostMessageの呼び出し
      await existingTransport.handlePostMessage(req, res, req.body);
    } else {
      console.error(`Session ${sessionId} exists but uses a different transport protocol`);
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: Session exists but uses a different transport protocol',
        },
        id: null,
      });
    }
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    console.log('Received health check request');
    res.status(200).send('OK');
  });
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`MCP HTTP/SSE Server running on port ${PORT}`);
    console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http (Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
==============================================
`);
    console.log("Server startup complete, ready to accept connections");
  });
  
  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.log('Received SIGINT signal, shutting down server...');
    // Close all active transports to properly clean up resources
    console.log(`Closing ${Object.keys(transports).length} active transports`);
    for (const sessionId in transports) {
      try {
        console.log(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    console.log('Server shutdown complete');
    process.exit(0);
  });
}

async function loadCredentialsAndRunServer() {
  console.log("Loading credentials and starting server...");
  if (!fs.existsSync(credentialsPath)) {
    console.error(
      "Credentials not found. Please run with 'auth' argument first.",
    );
    process.exit(1);
  }

  console.log(`Loading credentials from: ${credentialsPath}`);
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const auth = new google.auth.OAuth2();
  auth.setCredentials(credentials);
  google.options({ auth });
  console.log("Google auth credentials loaded successfully");

  // StdioトランスポートとHTTP/SSEトランスポートを両方設定
  console.log("Command line arguments:", process.argv);
  if (process.argv.includes("--http")) {
    console.log("Starting HTTP/SSE server based on command line flag");
    // HTTP/SSEサーバーを起動
    setupHttpServer();
  } else {
    console.log("Starting standard stdio transport (no --http flag detected)");
    // 標準の標準入出力トランスポート
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("Server connected with stdio transport");
  }
}

if (process.argv[2] === "auth") {
  console.log("Starting authentication process...");
  authenticateAndSaveCredentials().catch(console.error);
} else {
  console.log("Starting server with args:", process.argv);
  loadCredentialsAndRunServer().catch((error) => {
    console.error(`Error starting server: ${error}`);
    process.stderr.write(`Error: ${error}\n`);
    process.exit(1);
  });
}
