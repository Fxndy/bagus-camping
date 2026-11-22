import { getStore } from '@netlify/blobs';
import serverlessExpress from '@codegenie/serverless-express';
import { createApp, initNetlifyAdmin } from '../../server/index.js';
import { withBlobs } from '../../server/database.js';
import inventory from '../../server/inventory.js';

export const config = { path: ['/api/*', '/assets/uploads/products/*'] };
let dispatch;

export async function handle(request, context, stores) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  headers.host = url.host;
  headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
  const event = {
    path: url.pathname,
    httpMethod: request.method,
    headers,
    multiValueQueryStringParameters: Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
    requestContext: { identity: { sourceIp: context.ip } },
    body: request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null,
    isBase64Encoded: true
  };
  try {
    dispatch ??= serverlessExpress({ app: createApp({ netlify: true }), eventSourceName: 'AWS_API_GATEWAY_V1', respondWithErrors: false, binarySettings: { contentTypes: ['image/webp'] } });
    const result = await withBlobs(stores, async () => {
      inventory.initialize();
      if (request.method === 'POST' && /^\/api\/auth\/(login|register)\/?$/.test(url.pathname)) await initNetlifyAdmin();
      return dispatch(event, {});
    }, process.env.NETLIFY_DEV === 'true');
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(result.multiValueHeaders)) {
      for (const value of values) responseHeaders.append(name, value);
    }
    const body = request.method === 'HEAD' || [204, 304].includes(result.statusCode) ? null : Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8');
    return new Response(body, { status: result.statusCode, headers: responseHeaders });
  } catch (error) {
    if (error.code === 'DATABASE_CONFLICT') return Response.json({ error: error.message }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    console.error('Netlify API:', error.name, error.code || '', error.message);
    return Response.json({ error: 'Terjadi kesalahan pada server. Silakan coba kembali.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export default (request, context) => {
  const store = name => getStore({ name: `bagus-${name}`, consistency: 'strong' });
  return handle(request, context, { database: store('database'), sessions: store('sessions'), media: store('media') });
};
