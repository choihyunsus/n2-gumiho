const calls = [
  { id: 'first', name: 'lookup', arguments: { term: 'alpha' } },
  { id: 'second', name: 'lookup', arguments: { term: 'beta' } },
];
exports.cases = [
  {
    name: 'OpenAI Responses',
    factory: require('../dist/provider-openai').openAIResponses,
    response: {
      model: 'fixture',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'reason', encrypted_content: 'opaque-reasoning', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'first text' },
            { type: 'output_text', text: 'second text' },
          ],
        },
        ...calls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })),
      ],
      usage: { input_tokens: 15, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } },
    },
    inspect(assert, body, headers) {
      assert.equal(headers.authorization, 'Bearer fixture-key');
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 256);
      assert.equal(body.tools[0].strict, false);
      assert.deepEqual(body.input[1], this.response.output[0]);
      assert.deepEqual(
        body.input.slice(-2).map((item) => [item.type, item.call_id]),
        [
          ['function_call_output', 'first'],
          ['function_call_output', 'second'],
        ],
      );
    },
  },
  {
    name: 'Anthropic Messages',
    factory: require('../dist/provider-anthropic').anthropicMessages,
    response: {
      model: 'fixture',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'opaque fixture', signature: 'preserved-signature' },
        { type: 'text', text: 'first text' },
        { type: 'text', text: 'second text' },
        ...calls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ],
      usage: {
        input_tokens: 8,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        output_tokens: 7,
      },
    },
    inspect(assert, body, headers) {
      assert.equal(headers['x-api-key'], 'fixture-key');
      assert.equal(headers['anthropic-version'], '2026-10-21');
      assert.equal(body.max_tokens, 256);
      assert.deepEqual(body.messages[1].content, this.response.content);
      assert.equal(body.messages[2].role, 'user');
      assert.deepEqual(
        body.messages[2].content.map((item) => [item.type, item.tool_use_id]),
        [
          ['tool_result', 'first'],
          ['tool_result', 'second'],
        ],
      );
    },
  },
  {
    name: 'Gemini Interactions',
    factory: require('../dist/provider-gemini').geminiInteractions,
    response: {
      model: 'fixture',
      status: 'requires_action',
      steps: [
        { type: 'thought', signature: 'preserved-signature' },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'first text' },
            { type: 'text', text: 'second text' },
          ],
        },
        ...calls.map((call) => ({ type: 'function_call', ...call })),
      ],
      usage: {
        total_input_tokens: 15,
        total_output_tokens: 6,
        total_thought_tokens: 1,
        total_cached_tokens: 5,
      },
    },
    inspect(assert, body, headers) {
      assert.equal(headers['x-goog-api-key'], 'fixture-key');
      assert.equal(body.store, false);
      assert.equal(body.generation_config.max_output_tokens, 256);
      assert.deepEqual(body.input[1], this.response.steps[0]);
      assert.deepEqual(
        body.input.slice(-2).map((item) => [item.type, item.call_id]),
        [
          ['function_result', 'first'],
          ['function_result', 'second'],
        ],
      );
    },
  },
  {
    name: 'Ollama native',
    factory: require('../dist/provider-ollama').ollamaChat,
    response: {
      model: 'fixture',
      done: true,
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'first text\nsecond text',
        thinking: 'preserved-thinking',
        tool_calls: calls.map(({ name, arguments: args }) => ({
          function: { name, arguments: args },
        })),
      },
      prompt_eval_count: 15,
      eval_count: 7,
      prompt_eval_cached_count: 5,
    },
    inspect(assert, body) {
      assert.equal(body.stream, false);
      assert.equal(body.options.num_predict, 256);
      assert.deepEqual(body.messages[2], this.response.message);
      assert.deepEqual(
        body.messages.slice(-2).map((item) => [item.role, item.tool_name]),
        [
          ['tool', 'lookup'],
          ['tool', 'lookup'],
        ],
      );
    },
  },
  {
    name: 'Chat compatibility',
    factory: require('../dist/provider-chat').openAICompatible,
    response: {
      model: 'fixture',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'first text\nsecond text',
            reasoning_content: 'opaque-compatible-thinking',
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    },
    inspect(assert, body) {
      assert.equal(body.max_completion_tokens, 256);
      assert.deepEqual(body.messages[2], this.response.choices[0].message);
      assert.deepEqual(
        body.messages.slice(-2).map((item) => [item.role, item.tool_call_id]),
        [
          ['tool', 'first'],
          ['tool', 'second'],
        ],
      );
    },
  },
];
