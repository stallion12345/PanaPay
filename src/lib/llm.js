const OPENAI_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    return parts.join('\n');
  }

  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }

  return '';
}

function toTextFromOpenAIOutput(output) {
  const textParts = [];

  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const segment of item.content) {
        if (segment && segment.type === 'output_text' && typeof segment.text === 'string') {
          textParts.push(segment.text);
        }
      }
    }

    if (item.type === 'function_call' && typeof item.arguments === 'string') {
      textParts.push(item.arguments);
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n').trim();
  }

  return '';
}

function parseToolCalls(output) {
  const calls = [];

  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.type !== 'function_call') {
      continue;
    }

    calls.push({
      id: item.call_id || item.id || null,
      name: item.name || null,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
    });
  }

  return calls;
}

function convertJsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'OBJECT', properties: {} };
  }

  if (schema.type === 'object' || schema.type === 'OBJECT') {
    const converted = {
      type: 'OBJECT',
      properties: {},
    };

    if (Array.isArray(schema.required) && schema.required.length > 0) {
      converted.required = schema.required;
    }

    const sourceProperties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, value] of Object.entries(sourceProperties)) {
      converted.properties[key] = convertJsonSchemaToGemini(value);
    }

    if (Array.isArray(schema.enum)) {
      converted.enum = schema.enum;
    }

    if (typeof schema.description === 'string') {
      converted.description = schema.description;
    }

    return converted;
  }

  if (schema.type === 'array' || schema.type === 'ARRAY') {
    const converted = { type: 'ARRAY', items: convertJsonSchemaToGemini(schema.items) };
    if (Array.isArray(schema.enum)) {
      converted.enum = schema.enum;
    }
    return converted;
  }

  if (schema.type === 'string' || schema.type === 'STRING') {
    const converted = { type: 'STRING' };
    if (Array.isArray(schema.enum)) {
      converted.enum = schema.enum;
    }
    if (typeof schema.format === 'string') {
      converted.format = schema.format;
    }
    return converted;
  }

  if (schema.type === 'number' || schema.type === 'NUMBER' || schema.type === 'integer' || schema.type === 'INTEGER') {
    return { type: schema.type === 'INTEGER' || schema.type === 'integer' ? 'INTEGER' : 'NUMBER' };
  }

  if (schema.type === 'boolean' || schema.type === 'BOOLEAN') {
    return { type: 'BOOLEAN' };
  }

  if (schema.type === 'null' || schema.type === 'NULL') {
    return { type: 'NULL' };
  }

  if (Array.isArray(schema.oneOf)) {
    return { anyOf: schema.oneOf.map((option) => convertJsonSchemaToGemini(option)) };
  }

  return { type: 'OBJECT', properties: {} };
}

function toGeminiToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  return tools.map((tool) => {
    const def = tool && tool.function ? tool.function : tool;
    const parameters = def?.parameters ?? { type: 'object', properties: {} };

    return {
      name: def?.name || 'tool',
      description: def?.description || '',
      parameters: convertJsonSchemaToGemini(parameters),
    };
  });
}

function parseGeminiText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = candidates[0]?.content?.parts ?? [];
  const textParts = [];

  for (const part of parts) {
    if (part && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }

  return textParts.join('\n').trim();
}

function parseGeminiToolCalls(data) {
  const calls = [];
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = candidates[0]?.content?.parts ?? [];

  for (const part of parts) {
    if (!part || typeof part.functionCall !== 'object') {
      continue;
    }

    const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : null;
    const args = part.functionCall.args ?? {};
    calls.push({
      id: `gemini_${Math.random().toString(36).slice(2, 9)}`,
      name,
      arguments: JSON.stringify(args),
    });
  }

  return calls;
}

async function fetchWithRetry(url, options, timeoutMs = 20_000) {
  let attempt = 0;

  while (attempt <= 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt === 0) {
          attempt += 1;
          await delay(2000);
          continue;
        }

        if (response.status === 429) {
          throw new Error('rate limited. Please wait a moment and try again.');
        }

        throw new Error(`LLM provider request failed with status ${response.status}.`);
      }

      if (!response.ok) {
        throw new Error(`LLM provider request failed with status ${response.status}.`);
      }

      return response;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('LLM request timed out after 20 seconds.');
      }

      if (error && typeof error.message === 'string' && error.message.includes('rate limited')) {
        throw error;
      }

      if (attempt === 0 && error && typeof error.message === 'string' && /429|5\d\d/.test(error.message)) {
        attempt += 1;
        await delay(2000);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('LLM request failed after retrying once.');
}

async function callGemini({ system, messages = [], tools = [], jsonSchema }) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set.');
  }

  const modelName = String(process.env.LLM_MODEL || 'gemini-2.0-flash');

  const payload = {
    contents: [],
    tools: undefined,
    generationConfig: undefined,
  };

  if (system) {
    payload.systemInstruction = {
      parts: [{ text: String(system) }],
    };
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const role = String(message.role ?? 'user').toLowerCase();
    const content = safeMessageContent(message.content);
    if (!content) {
      continue;
    }

    const mappedRole = role === 'assistant' || role === 'model' ? 'model' : 'user';
    payload.contents.push({
      role: mappedRole,
      parts: [{ text: content }],
    });
  }

  const toolDefinitions = toGeminiToolDefinitions(tools);
  if (toolDefinitions.length > 0) {
    payload.tools = [{ functionDeclarations: toolDefinitions }];
  }

  if (jsonSchema) {
    const schema = jsonSchema.schema ?? jsonSchema;
    payload.generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: convertJsonSchemaToGemini(schema),
    };
  }

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    20_000,
  );

  const data = await response.json();
  const text = parseGeminiText(data);
  const toolCalls = parseGeminiToolCalls(data);

  if (jsonSchema) {
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: '', toolCalls };
    }

    try {
      const parsed = JSON.parse(trimmed);
      return { text: JSON.stringify(parsed), toolCalls };
    } catch {
      return { text: trimmed, toolCalls };
    }
  }

  return { text, toolCalls };
}

export async function callModel({ system, messages = [], tools = [], jsonSchema } = {}) {
  const provider = String(process.env.LLM_PROVIDER || 'openai').toLowerCase();

  if (provider === 'gemini') {
    return callGemini({ system, messages, tools, jsonSchema });
  }

  if (provider !== 'openai') {
    throw new Error(`Unsupported LLM provider: ${provider}. Allowed values are: openai, gemini.`);
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set.');
  }

  const input = [];
  if (system) {
    input.push({ role: 'system', content: String(system) });
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = safeMessageContent(message.content);

    input.push({ role, content });
  }

  const payload = {
    model: DEFAULT_MODEL,
    input,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  if (jsonSchema) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: {
        name: typeof jsonSchema.name === 'string' ? jsonSchema.name : 'response_schema',
        schema: jsonSchema.schema ?? jsonSchema,
        strict: true,
      },
    };
  }

  const response = await fetchWithRetry(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, 20_000);

  const data = await response.json();
  const text = toTextFromOpenAIOutput(data.output) || data.output_text || '';
  return {
    text,
    toolCalls: parseToolCalls(data.output),
  };
}
