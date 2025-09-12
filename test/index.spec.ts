import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// Mocks para OpenAI e Supabase
const openaiCreateMock = vi.fn();
vi.mock('openai', () => {
  return {
    default: class OpenAI {
      chat = { completions: { create: openaiCreateMock } };
      constructor(_: any) {}
    },
  };
});

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: () => ({
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: [], error: null }),
    }),
  };
});

describe('Perso worker', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openaiCreateMock.mockReset();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('executes buscar_programas_weburn via chamada direta e retorna sucesso', async () => {
    // 1ª chamada do OpenAI: solicita tool call buscar_programas_weburn
    // 2ª chamada: retorna resposta final do agente
    let call = 0;
    openaiCreateMock.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tool1',
                    type: 'function',
                    function: {
                      name: 'buscar_programas_weburn',
                      arguments: JSON.stringify({
                        nivel: 'Iniciante',
                        modalidade: 'HIIT',
                        possui_equipamentos: false,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        } as any;
      }
      return {
        choices: [
          {
            message: { role: 'assistant', content: 'Aqui estão alguns programas.' },
          },
        ],
      } as any;
    });

    // Mock do fetch para Weburn e n8n
    fetchSpy.mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('example.weburn')) {
        return new Response(
          JSON.stringify([{ id: 'p1', titulo: 'HIIT Iniciante' }]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('n8n.example')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const env: any = {
      OPENAI_API_KEY: 'sk-test',
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_ANON_KEY: 'anon',
      N8N_WEBHOOK_URL: 'https://n8n.example/webhook',
      N8N_API_KEY: 'secret',
      WEBURN_API_URL: 'https://example.weburn/api/programas',
    };

    const req = new Request('http://worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', newMessage: 'Quero HIIT iniciante' }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.metadata.toolCallsExecuted).toBeGreaterThanOrEqual(1);
  });

  it('retorna erro 500 quando envs obrigatórias faltam', async () => {
    const env: any = {
      // OPENAI_API_KEY ausente
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_ANON_KEY: 'anon',
      N8N_WEBHOOK_URL: 'https://n8n.example/webhook',
      N8N_API_KEY: 'secret',
    };

    const req = new Request('http://worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', newMessage: 'ping' }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
