// Netlify Serverless Function — AI Proxy
// Prevents CORS by routing Anthropic API calls through this server-side function
// Deploy: this file auto-deploys when you push to Netlify
// Set env var: ANTHROPIC_API_KEY in Netlify dashboard → Site settings → Environment variables

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

exports.handler = async (event, context) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers — allow your Netlify domain
  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type, X-Requested-With',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify environment variables. Go to Site Settings → Environment variables and add it.' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Validate required fields
    if (!body.messages || !Array.isArray(body.messages)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages array required' }) };
    }

    const response = await fetch(ANTHROPIC_API, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      body.model      || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1024,
        system:     body.system     || '',
        messages:   body.messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal proxy error' }),
    };
  }
};
