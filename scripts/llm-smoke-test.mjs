import { callModel } from '../src/lib/llm.js';

async function main() {
  const plain = await callModel({
    system: 'Answer the user clearly and concisely.',
    messages: [{ role: 'user', content: 'What is 2 + 2?' }],
  });

  console.log('Plain model response:');
  console.log(plain.text);

  const jsonResult = await callModel({
    system: 'Return valid JSON only.',
    messages: [{ role: 'user', content: 'Transaction: Fabric purchase from wholesaler, $240' }],
    jsonSchema: {
      name: 'transaction_classification',
      schema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['category', 'confidence'],
        additionalProperties: false,
      },
    },
  });

  console.log('Structured JSON result:');
  console.log(jsonResult.text);

  try {
    console.log('Parsed JSON result:', JSON.parse(jsonResult.text));
  } catch (error) {
    console.log('Parsed JSON result: unable to parse the model output as JSON.');
    console.error(error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LLM smoke test failed: ${message}`);
  process.exitCode = 1;
});
