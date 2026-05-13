/**
 * MCP Server bridge for the intelligence feeder.
 * Exposes tools that Samaritan can discover via its existing MCP integration.
 *
 * Usage:
 *   node dist/mcp-server.js
 *
 * Or configured in Samaritan's configs/mcp-servers.json:
 *   {
 *     "intelligence-feeder": {
 *       "command": "node",
 *       "args": ["./feeder/dist/mcp-server.js"],
 *       "env": { "DATABASE_URL": "..." }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listSources } from './store/sources.js';
import { searchEvents, getEvent } from './store/events.js';

async function main(): Promise<void> {
  const server = new Server(
    { name: 'samaritan-intelligence-feeder', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_intelligence_sources',
        description: 'List all configured intelligence sources (feeds, cameras, social media).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'query_intelligence_events',
        description: 'Search recent intelligence events by keyword, kind, or time range.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword search query' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['visual', 'text', 'anomaly', 'alert', 'social_post'] },
              description: 'Filter by event kinds',
            },
            since_hours: { type: 'number', default: 24, description: 'How many hours back to search' },
            limit: { type: 'number', default: 10, description: 'Max results' },
          },
        },
      },
      {
        name: 'get_intelligence_event',
        description: 'Get a single intelligence event by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'Event UUID' },
          },
          required: ['event_id'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'list_intelligence_sources') {
        const sources = await listSources();
        return {
          content: [{ type: 'text', text: JSON.stringify(sources, null, 2) }],
        };
      }

      if (name === 'query_intelligence_events') {
        const a = args ?? {};
        const since = Date.now() - ((a.since_hours as number) ?? 24) * 60 * 60 * 1000;
        const events = await searchEvents({
          query: (a.query as string) ?? undefined,
          kinds: (a.kinds as string[]) as ('visual' | 'text' | 'anomaly' | 'trend' | 'alert' | 'social_post')[] ?? undefined,
          since,
          limit: (a.limit as number) ?? 10,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
        };
      }

      if (name === 'get_intelligence_event') {
        const a = args ?? {};
        const event = await getEvent(String(a.event_id));
        return {
          content: [{ type: 'text', text: event ? JSON.stringify(event, null, 2) : 'Event not found' }],
        };
      }

      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Intelligence feeder MCP server running on stdio');
}

main().catch((err) => {
  console.error('[mcp] Fatal error:', err);
  process.exit(1);
});
