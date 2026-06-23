import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';

// Create a WebSocket server to broadcast patches to the Canopy React app
// We run this on 18803. The React app should connect to ws://localhost:18803/spatial-sync
const wss = new WebSocketServer({ port: 18803 });

let connectedClients = [];

wss.on('connection', (ws) => {
  console.log('Spatial Canvas connected to MCP server.');
  connectedClients.push(ws);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'telemetry') {
        // Store the latest telemetry so the agent can request it,
        // or feed it into the context if supported.
        global.latestTelemetry = data.data;
      }
    } catch (e) {
      console.error('Error parsing telemetry:', e);
    }
  });

  ws.on('close', () => {
    connectedClients = connectedClients.filter(client => client !== ws);
  });
});

function broadcastPatch(patch) {
  const payload = JSON.stringify(patch);
  for (const client of connectedClients) {
    client.send(payload);
  }
}

// Initialize the MCP Server
const server = new Server({
  name: 'spatial-mcp-server',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

// Expose the tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'patch_scene',
        description: 'Update the live 3D WebXR scene instantly without regenerating the whole file. Use this during a Live Spatial Canvas session.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'swap_mesh'] },
            targetId: { type: 'string', description: 'Unique ID of the object to modify' },
            newAsset: { type: 'string', description: 'URL or name of the new GLB/USDZ asset' },
            position: { type: 'array', items: { type: 'number' }, description: '[x, y, z] coordinates' }
          },
          required: ['action', 'targetId']
        }
      },
      {
        name: 'get_telemetry',
        description: 'Get the user\'s current headset telemetry (gaze, position, hovered object) from the Live Canvas.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'generate_3d_model',
        description: 'Phase 1: Generate a static 3D model (USDZ/GLB) from a prompt using external generative APIs.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Semantic description of the object to generate.' },
            format: { type: 'string', enum: ['usdz', 'glb'], description: 'Desired output format based on device' }
          },
          required: ['prompt', 'format']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === 'patch_scene') {
    // Broadcast the update to the React UI
    broadcastPatch(args);
    return {
      content: [
        { type: 'text', text: `Scene patched successfully: ${JSON.stringify(args)}` }
      ]
    };
  }
  
  if (name === 'get_telemetry') {
    const telemetry = global.latestTelemetry || { status: 'No telemetry received yet' };
    return {
      content: [
        { type: 'text', text: JSON.stringify(telemetry) }
      ]
    };
  }
  
  if (name === 'generate_3d_model') {
    // Mocking an external API call to Meshy / Luma
    const filename = args.format === 'usdz' ? 'generated_model.usdz' : 'generated_model.glb';
    const mockUrl = `https://mock-3d-api.example.com/assets/${filename}`;
    return {
      content: [
        { type: 'text', text: `Successfully generated ${args.format.toUpperCase()} model for prompt: "${args.prompt}".\nDownload URL: ${mockUrl}` }
      ]
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

// Run via stdio
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.log('Spatial MCP Server running on stdio');
}).catch(e => {
  console.error('MCP Server error:', e);
  process.exit(1);
});
